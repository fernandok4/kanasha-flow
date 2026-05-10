#!/usr/bin/env node
'use strict';

const newman = require('newman');
const yaml   = require('js-yaml');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, '.run-state.json');

// ─── helpers ────────────────────────────────────────────────────────────────

function loadCollection(name) {
  const file = path.join(ROOT, 'collections', `${name}.postman_collection.json`);
  if (!fs.existsSync(file)) throw new Error(`Collection not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadAllCollections() {
  const dir = path.join(ROOT, 'collections');
  if (!fs.existsSync(dir)) return {};
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.postman_collection.json'))
    .reduce((acc, f) => {
      const name = f.replace('.postman_collection.json', '');
      acc[name] = loadCollection(name);
      return acc;
    }, {});
}

function loadEnvironment(name) {
  const file = path.join(ROOT, 'environments', `${name}.postman_environment.json`);
  if (!fs.existsSync(file)) throw new Error(`Environment not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(vars) {
  const existing = loadState();
  const updated = { ...existing };
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined && v !== '' && v !== null) updated[k] = v;
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(updated, null, 2));
}

function clearState() {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

function resolveVars(str, vars) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{{${k}}}`));
}

function findRequest(collection, folderName, requestName) {
  const folder = collection.item.find(i => i.name === folderName && Array.isArray(i.item));
  if (!folder) throw new Error(`Folder "${folderName}" not found in collection "${collection.info.name}"`);
  const req = folder.item.find(i => i.name === requestName);
  if (!req) {
    const available = folder.item.map(i => i.name).join(', ');
    throw new Error(`Request "${requestName}" not found in folder "${folderName}". Available: ${available}`);
  }
  return JSON.parse(JSON.stringify(req));
}

function applyBodyOverride(request, overrides, vars) {
  if (!overrides || !request.request.body) return;
  let raw = request.request.body.raw || '{}';
  raw = resolveVars(raw, vars);
  const body = JSON.parse(raw);
  for (const [key, value] of Object.entries(overrides)) {
    body[key] = resolveVars(String(value), vars);
  }
  request.request.body.raw = JSON.stringify(body, null, 2);
}

function buildEnvValues(vars) {
  return Object.entries(vars).map(([key, value]) => ({ key, value: String(value), enabled: true }));
}

function mergeEnvFromSummary(summary, vars) {
  const members = summary.environment?.values?.members || [];
  for (const m of members) {
    if (m.value !== undefined && m.value !== '') {
      vars[m.key] = m.value;
    }
  }
}

function extractFromRow(row, extracts, vars) {
  if (!row || !extracts) return;
  for (const [varName, jpPath] of Object.entries(extracts)) {
    const key = jpPath.replace(/^\$\./, '');
    const val = row[key];
    if (val !== undefined && val !== null) {
      vars[varName] = String(val);
      console.log(`     ${varName} = ${val}`);
    }
  }
}

// ─── validation ──────────────────────────────────────────────────────────────

function validateFlow(flow, flowPath) {
  const errors = [];

  if (!flow.name || typeof flow.name !== 'string')
    errors.push('"name" is required and must be a string');
  if (!Array.isArray(flow.steps) || flow.steps.length === 0)
    errors.push('"steps" is required and must be a non-empty array');

  const validateSteps = (steps, label) => {
    steps.forEach((step, i) => {
      const ctx = `${label}[${i}]`;
      if (step.type === 'human-input') {
        if (!step.store) errors.push(`${ctx}: human-input step requires "store"`);
      } else if (step.type === 'db-query') {
        if (!step.connection) errors.push(`${ctx}: db-query step requires "connection"`);
        if (!step.query)      errors.push(`${ctx}: db-query step requires "query"`);
      } else {
        if (!step.collection) errors.push(`${ctx}: missing "collection"`);
        if (!step.folder)     errors.push(`${ctx}: missing "folder"`);
        if (!step.request)    errors.push(`${ctx}: missing "request"`);
      }
    });
  };

  if (Array.isArray(flow.steps))    validateSteps(flow.steps,    'steps');
  if (Array.isArray(flow.setup))    validateSteps(flow.setup,    'setup');
  if (Array.isArray(flow.teardown)) validateSteps(flow.teardown, 'teardown');

  if (errors.length > 0) {
    throw new Error(`Invalid flow "${flowPath}":\n${errors.map(e => `  • ${e}`).join('\n')}`);
  }
}

// ─── step runners ────────────────────────────────────────────────────────────

function promptUser(question) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`\n  ❓ ${question}: `, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function runHumanInputStep(step, vars) {
  const { prompt, store } = step;
  if (!store) throw new Error('human-input step requires a "store" variable name');
  const message = resolveVars(prompt || `Enter value for ${store}`, vars);
  const value = await promptUser(message);
  vars[store] = value;
  console.log(`     ${store} = ${value}`);
  return { passed: 1, failed: 0 };
}

async function runDbQueryStep(step, vars) {
  const { Client } = require('pg');
  const { query: rawQuery, connection: rawConn, extract } = step;

  const connStr = resolveVars(rawConn, vars);
  const query   = resolveVars(rawQuery, vars);

  const stmt = query.trim().toUpperCase();
  if (!stmt.startsWith('SELECT') && !stmt.startsWith('WITH')) {
    throw new Error('db-query only allows SELECT statements');
  }

  const client = new Client({ connectionString: connStr });
  try {
    await client.connect();
    const result = await client.query(query);
    const row = result.rows[0] || null;
    extractFromRow(row, extract, vars);
    return { passed: 1, failed: 0 };
  } finally {
    await client.end().catch(() => {});
  }
}

function runRequestStep(step, vars, collections) {
  const { collection: collName, folder, request: reqName, body_override, extract } = step;

  const collection = collections[collName];
  if (!collection) throw new Error(`Collection "${collName}" not loaded`);

  const request = findRequest(collection, folder, reqName);
  if (body_override) applyBodyOverride(request, body_override, vars);

  // Resolve relative file paths in formdata to absolute paths from project root
  if (request.request?.body?.mode === 'formdata') {
    for (const part of request.request.body.formdata || []) {
      if (part.type === 'file' && part.src && !path.isAbsolute(part.src)) {
        part.src = path.join(ROOT, part.src);
      }
    }
  }

  const miniCollection = {
    info: { ...collection.info, name: `[flow] ${reqName}` },
    item: [request]
  };

  return new Promise((resolve, reject) => {
    newman.run({
      collection: miniCollection,
      environment: { id: 'flow-env', values: buildEnvValues(vars) },
      insecureFileRead: true,
      reporters: [],
      reporter: {}
    }, (err, summary) => {
      if (err) return reject(err);

      mergeEnvFromSummary(summary, vars);

      if (extract) {
        const exec = summary.run.executions[0];
        try {
          const body = JSON.parse(exec?.response?.stream?.toString() || '{}');
          for (const [varName, jpPath] of Object.entries(extract)) {
            const keys = jpPath.replace(/^\$\./, '').split('.');
            let val = body;
            for (const k of keys) val = val?.[k];
            if (val !== undefined) {
              vars[varName] = val;
              console.log(`     ${varName} = ${val}`);
            }
          }
        } catch {}
      }

      const assertions = summary.run.executions.flatMap(e => e.assertions || []);
      const passed = assertions.filter(a => !a.error).length;
      const failed = assertions.filter(a => a.error).length;
      const failures = summary.run.failures || [];

      if (failures.length > 0) {
        for (const f of failures) {
          console.log(`     ✗ ${f.error?.message || f.error}`);
        }
      }

      resolve({ passed, failed, hasFailed: failures.length > 0 });
    });
  });
}

// ─── phase runner ────────────────────────────────────────────────────────────

async function runStep(step, vars, collections) {
  if (step.type === 'human-input') return runHumanInputStep(step, vars);
  if (step.type === 'db-query')    return runDbQueryStep(step, vars);
  return runRequestStep(step, vars, collections);
}

async function runPhase(steps, vars, collections, stopOnFailure) {
  let totalPassed = 0;
  let totalFailed = 0;
  const stepResults = [];

  for (const step of steps) {
    const label = step.name || `${step.folder} / ${step.request}`;
    process.stdout.write(`\n  ▶ ${label}\n`);

    const allowFailure = step.allow_failure === true;

    try {
      const result = await runStep(step, vars, collections);

      const ok = !result.hasFailed && result.failed === 0;

      if (allowFailure && !ok) {
        console.log(`     ⚠️  skipped (allow_failure) — ${result.passed} assertions`);
        stepResults.push({ step: label, ok: true, passed: result.passed, failed: 0, skipped: true });
      } else {
        totalPassed += result.passed;
        totalFailed += result.failed;
        console.log(`     ${ok ? '✓ passed' : '✗ failed'} (${result.passed} assertions)`);
        stepResults.push({ step: label, ok, passed: result.passed, failed: result.failed });

        if (!ok && stopOnFailure) {
          console.log(`\n  ⛔ Stopping — step failed and stop_on_failure is enabled`);
          break;
        }
      }
    } catch (e) {
      if (allowFailure) {
        console.log(`     ⚠️  skipped (allow_failure) — ${e.message}`);
        stepResults.push({ step: label, ok: true, passed: 0, failed: 0, skipped: true });
      } else {
        totalFailed++;
        console.log(`     ✗ ERROR: ${e.message}`);
        stepResults.push({ step: label, ok: false, error: e.message });
        if (stopOnFailure) {
          console.log(`\n  ⛔ Stopping — unhandled error`);
          break;
        }
      }
    }
  }

  return { totalPassed, totalFailed, stepResults };
}

// ─── flow runner ─────────────────────────────────────────────────────────────

function flowHasHumanInput(flowFile) {
  const flowPath = path.isAbsolute(flowFile)
    ? flowFile
    : path.join(ROOT, 'tests', flowFile);
  if (!fs.existsSync(flowPath)) return false;
  const flow = yaml.load(fs.readFileSync(flowPath, 'utf8'));
  const all = [...(flow.steps || []), ...(flow.setup || []), ...(flow.teardown || [])];
  return all.some(s => s.type === 'human-input');
}

async function runFlow(flowFile, envName = 'local') {
  const flowPath = path.isAbsolute(flowFile)
    ? flowFile
    : path.join(ROOT, 'tests', flowFile);

  if (!fs.existsSync(flowPath)) throw new Error(`Flow file not found: ${flowPath}`);

  const flow = yaml.load(fs.readFileSync(flowPath, 'utf8'));
  validateFlow(flow, flowPath);

  console.log(`\n${'═'.repeat(62)}`);
  console.log(` 🧪 ${flow.name}`);
  if (flow.description) console.log(` ${flow.description.trim()}`);
  console.log('═'.repeat(62));

  const env = loadEnvironment(envName);
  const vars = {};
  for (const v of env.values) {
    if (v.enabled && v.value !== '') vars[v.key] = v.value;
  }
  Object.assign(vars, loadState());

  const collections = loadAllCollections();
  const stopOnFailure = flow.stop_on_failure !== false;

  let setupResults    = { totalPassed: 0, totalFailed: 0, stepResults: [] };
  let mainResults     = { totalPassed: 0, totalFailed: 0, stepResults: [] };
  let teardownResults = { totalPassed: 0, totalFailed: 0, stepResults: [] };

  if (flow.setup?.length) {
    console.log(`\n${'·'.repeat(62)}`);
    console.log(`  SETUP`);
    setupResults = await runPhase(flow.setup, vars, collections, true);
  }

  if (setupResults.totalFailed === 0) {
    mainResults = await runPhase(flow.steps, vars, collections, stopOnFailure);
  } else {
    console.log(`\n  ⛔ Setup failed — skipping main steps`);
  }

  if (flow.teardown?.length) {
    console.log(`\n${'·'.repeat(62)}`);
    console.log(`  TEARDOWN`);
    teardownResults = await runPhase(flow.teardown, vars, collections, false);
    if (teardownResults.totalFailed > 0) {
      console.log(`\n  ⚠️  ${teardownResults.totalFailed} teardown step(s) failed — not counted as test failures`);
    }
  }

  saveState(vars);

  const totalPassed = setupResults.totalPassed + mainResults.totalPassed;
  const totalFailed = setupResults.totalFailed + mainResults.totalFailed;

  console.log(`\n${'─'.repeat(62)}`);
  console.log(` ✅ ${totalPassed} passed   ❌ ${totalFailed} failed`);
  console.log('─'.repeat(62));

  const stepResults = [
    ...setupResults.stepResults.map(s => ({ ...s, phase: 'setup' })),
    ...mainResults.stepResults,
    ...teardownResults.stepResults.map(s => ({ ...s, phase: 'teardown' })),
  ];

  return { name: flow.name, description: flow.description, totalPassed, totalFailed, stepResults };
}

// ─── reporting ───────────────────────────────────────────────────────────────

function ensureReportsDir() {
  const dir = path.join(ROOT, 'reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  return dir;
}

function buildHtml(report) {
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const allOk = report.summary.failed === 0;

  const stepRows = steps => steps.map(s => {
    const phaseTag = s.phase ? ` <span class="phase-tag ${s.phase}">${s.phase}</span>` : '';
    return `
      <tr class="${s.ok ? '' : 'fail-row'}">
        <td>${esc(s.step)}${phaseTag}</td>
        <td class="status ${s.ok ? 'ok' : 'ko'}">${s.ok ? '✓ passed' : '✗ failed'}</td>
        <td class="num">${s.passed ?? 0}</td>
        <td class="num">${s.failed ?? 0}</td>
        <td class="err">${esc(s.error ?? '')}</td>
      </tr>`;
  }).join('');

  const flowSections = report.flows
    ? report.flows.map(f => {
        const fOk = f.summary.failed === 0;
        return `
    <section>
      <h2 class="flow-title ${fOk ? 'ok' : 'ko'}">${esc(f.name)}</h2>
      ${f.description ? `<p class="flow-desc">${esc(f.description)}</p>` : ''}
      <p class="flow-badge"><span class="badge ${fOk ? 'pass' : 'fail'}">${fOk ? '✓' : '✗'}</span>
        ${f.summary.passed} passed · ${f.summary.failed} failed · ${f.steps.length} steps</p>
      <table><thead><tr><th>Step</th><th>Status</th><th>Passed</th><th>Failed</th><th>Error</th></tr></thead>
      <tbody>${stepRows(f.steps)}</tbody></table>
    </section>`;
      }).join('')
    : `<section>
      <table><thead><tr><th>Step</th><th>Status</th><th>Passed</th><th>Failed</th><th>Error</th></tr></thead>
      <tbody>${stepRows(report.steps)}</tbody></table>
    </section>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(report.name)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#f8fafc;color:#1e293b}
    .header{background:#1e293b;color:#f8fafc;padding:22px 32px}
    .header h1{font-size:1.3rem;font-weight:700}
    .header p{margin-top:4px;font-size:.85rem;opacity:.65}
    .summary{display:flex;gap:12px;align-items:center;padding:16px 32px;background:#fff;border-bottom:1px solid #e2e8f0;flex-wrap:wrap}
    .badge{display:inline-block;padding:4px 12px;border-radius:5px;font-size:.8rem;font-weight:600}
    .badge.pass{background:#dcfce7;color:#15803d}
    .badge.fail{background:#fee2e2;color:#b91c1c}
    .badge.info{background:#e2e8f0;color:#475569}
    main{padding:24px 32px;display:flex;flex-direction:column;gap:28px}
    .flow-title{font-size:1rem;font-weight:700;margin-bottom:4px}
    .flow-title.ok{color:#15803d}.flow-title.ko{color:#b91c1c}
    .flow-desc{font-size:.82rem;color:#64748b;margin-bottom:6px}
    .flow-badge{font-size:.82rem;color:#475569;margin-bottom:10px}
    table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.07)}
    th{background:#f1f5f9;text-align:left;padding:9px 14px;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:#64748b}
    td{padding:9px 14px;font-size:.85rem;border-top:1px solid #f1f5f9;vertical-align:top}
    tr.fail-row td{background:#fff7f7}
    td.status.ok{color:#15803d;font-weight:600}
    td.status.ko{color:#b91c1c;font-weight:600}
    td.num{text-align:right;width:70px}
    td.err{color:#b91c1c;font-size:.8rem}
    .phase-tag{font-size:.7rem;padding:1px 6px;border-radius:3px;margin-left:6px;font-weight:600;text-transform:uppercase}
    .phase-tag.setup{background:#dbeafe;color:#1d4ed8}
    .phase-tag.teardown{background:#fef9c3;color:#854d0e}
    .footer{padding:14px 32px;font-size:.72rem;color:#94a3b8}
  </style>
</head>
<body>
  <div class="header">
    <h1>${esc(report.name)}</h1>
    ${report.description ? `<p>${esc(report.description)}</p>` : ''}
  </div>
  <div class="summary">
    <span class="badge ${allOk ? 'pass' : 'fail'}">${allOk ? '✓ All passed' : '✗ Has failures'}</span>
    <span class="badge info">✅ ${report.summary.passed} passed</span>
    ${report.summary.failed > 0 ? `<span class="badge fail">❌ ${report.summary.failed} failed</span>` : ''}
    ${report.flows ? `<span class="badge info">${report.flows.length} flows</span>` : `<span class="badge info">${report.steps.length} steps</span>`}
    <span class="badge info">${new Date(report.timestamp).toLocaleString()}</span>
  </div>
  <main>${flowSections}</main>
  <div class="footer">api-tests runner · ${esc(report.timestamp)}</div>
</body>
</html>`;
}

function buildJunit(report) {
  const esc = s => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const testcases = (steps, suiteName) => steps
    .filter(s => s.phase !== 'teardown')
    .map(s => {
      const attrs = `name="${esc(s.step)}" classname="${esc(suiteName)}" time="0"`;
      if (s.ok) return `    <testcase ${attrs}/>`;
      const msg = esc(s.error || 'assertion failed');
      return `    <testcase ${attrs}>\n      <failure message="${msg}"/>\n    </testcase>`;
    }).join('\n');

  if (report.flows) {
    const total    = report.flows.reduce((n, f) => n + f.steps.filter(s => s.phase !== 'teardown').length, 0);
    const failures = report.summary.failed;
    const suites   = report.flows.map(f => {
      const fSteps = f.steps.filter(s => s.phase !== 'teardown');
      return `  <testsuite name="${esc(f.name)}" tests="${fSteps.length}" failures="${f.summary.failed}" time="0">\n${testcases(f.steps, f.name)}\n  </testsuite>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${esc(report.name)}" tests="${total}" failures="${failures}" time="0">\n${suites}\n</testsuites>`;
  }

  const steps    = (report.steps || []).filter(s => s.phase !== 'teardown');
  const failures = report.summary.failed;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${esc(report.name)}" tests="${steps.length}" failures="${failures}" time="0">\n${testcases(report.steps || [], report.name)}\n</testsuite>`;
}

function saveReport(flowResult, withJunit) {
  const dir = ensureReportsDir();
  const slug = flowResult.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const ts = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const base = path.join(dir, `${ts}_${slug}`);

  const data = {
    name: flowResult.name,
    description: flowResult.description || '',
    timestamp: new Date().toISOString(),
    summary: { passed: flowResult.totalPassed, failed: flowResult.totalFailed },
    steps: flowResult.stepResults,
  };

  fs.writeFileSync(`${base}.json`, JSON.stringify(data, null, 2));
  fs.writeFileSync(`${base}.html`, buildHtml(data));
  console.log(`\n  📄 ${base}.json`);
  console.log(`  📄 ${base}.html`);

  if (withJunit) {
    fs.writeFileSync(`${base}.xml`, buildJunit(data));
    console.log(`  📄 ${base}.xml`);
  }
}

function saveCombinedReport(flowResults, withJunit) {
  const dir = ensureReportsDir();
  const ts = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const base = path.join(dir, `${ts}_all-flows`);

  const totalPassed = flowResults.reduce((s, f) => s + f.totalPassed, 0);
  const totalFailed = flowResults.reduce((s, f) => s + f.totalFailed, 0);

  const data = {
    name: 'All Flows',
    description: '',
    timestamp: new Date().toISOString(),
    summary: { passed: totalPassed, failed: totalFailed },
    flows: flowResults.map(f => ({
      name: f.name,
      description: f.description || '',
      summary: { passed: f.totalPassed, failed: f.totalFailed },
      steps: f.stepResults,
    })),
  };

  fs.writeFileSync(`${base}.json`, JSON.stringify(data, null, 2));
  fs.writeFileSync(`${base}.html`, buildHtml(data));
  console.log(`\n  📄 ${base}.json`);
  console.log(`  📄 ${base}.html`);

  if (withJunit) {
    fs.writeFileSync(`${base}.xml`, buildJunit(data));
    console.log(`  📄 ${base}.xml`);
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function runSingleRequest(collectionName, folderName, requestName, envName = 'local') {
  console.log(`\n${'═'.repeat(62)}`);
  console.log(` 🔧 ${collectionName} › ${folderName} › ${requestName}`);
  console.log('═'.repeat(62));

  const env = loadEnvironment(envName);
  const vars = {};
  for (const v of env.values) {
    if (v.enabled && v.value !== '') vars[v.key] = v.value;
  }
  Object.assign(vars, loadState());

  const collections = loadAllCollections();

  const step = { collection: collectionName, folder: folderName, request: requestName };
  const result = await runRequestStep(step, vars, collections);

  saveState(vars);

  console.log(`\n${'─'.repeat(62)}`);
  console.log(` ✅ ${result.passed} passed   ❌ ${result.failed} failed`);
  console.log('─'.repeat(62));

  return result;
}

function listRequests() {
  const collections = loadAllCollections();

  for (const [collName, coll] of Object.entries(collections)) {
    console.log(`\n📦 ${collName}`);
    for (const folder of coll.item.filter(i => Array.isArray(i.item))) {
      console.log(`  📁 ${folder.name}`);
      for (const req of folder.item) {
        console.log(`     • ${req.name}`);
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log(`
Usage:
  node runner.js <flow.yml> [environment] [--auto] [--report] [--junit] [--fresh]
  node runner.js --all [environment] [--auto] [--report] [--junit] [--fresh]
  node runner.js --request <collection> <folder> <request> [environment]
  node runner.js --list

Flags:
  --auto     Skip flows that contain human-input steps (for CI/CD)
  --report   Generate JSON + HTML report in reports/ after the run
  --junit    Generate JUnit XML report in reports/ (for GitLab/GitHub CI)
  --fresh    Clear persisted state before running (start from scratch)

Examples:
  node runner.js auth/login-success.yml
  node runner.js auth/login-success.yml local --report --junit
  node runner.js --all local
  node runner.js --all --auto --junit
  node runner.js --all --fresh --auto --junit
  node runner.js --request authentication-service "OAuth2" "Get Company Token"
  node runner.js --list
`);
    process.exit(0);
  }

  if (args[0] === '--list') {
    listRequests();
    process.exit(0);
  }

  const fresh = args.includes('--fresh');
  if (fresh) {
    clearState();
    console.log('  🧹 State cleared (--fresh)');
  }

  if (args[0] === '--request') {
    const positional = args.slice(1).filter(a => !a.startsWith('--'));
    const [collectionName, folderName, requestName, envName] = positional;
    if (!collectionName || !folderName || !requestName) {
      console.error('Usage: --request <collection> <folder> <request> [environment]');
      process.exit(1);
    }
    const result = await runSingleRequest(collectionName, folderName, requestName, envName || 'local');
    process.exit(result.hasFailed ? 1 : 0);
  }

  const report   = args.includes('--report');
  const junit    = args.includes('--junit');
  const autoOnly = args.includes('--auto');
  const envName  = args.find(a => !a.startsWith('--') && !a.endsWith('.yml') && a !== args[0]) || 'local';

  if (args[0] === '--all') {
    const testsDir = path.join(ROOT, 'tests');
    const allFiles = fs.readdirSync(testsDir, { recursive: true })
      .filter(f => f.endsWith('.yml'))
      .sort();

    const skipped = [];
    const toRun   = [];
    for (const f of allFiles) {
      if (autoOnly && flowHasHumanInput(f)) skipped.push(f);
      else toRun.push(f);
    }

    if (autoOnly && skipped.length > 0) {
      console.log(`\n  ⏭  Skipping ${skipped.length} manual flow(s) (--auto):`);
      for (const f of skipped) console.log(`     • ${f}`);
    }

    const flowResults = [];
    for (const f of toRun) {
      const result = await runFlow(f, envName);
      flowResults.push(result);
    }

    const grand = flowResults.reduce((s, f) => ({ passed: s.passed + f.totalPassed, failed: s.failed + f.totalFailed }), { passed: 0, failed: 0 });
    console.log(`\n${'═'.repeat(62)}`);
    console.log(` ALL FLOWS — ✅ ${grand.passed} passed   ❌ ${grand.failed} failed${skipped.length > 0 ? `   ⏭  ${skipped.length} skipped` : ''}`);
    console.log('═'.repeat(62));

    if (report || junit) saveCombinedReport(flowResults, junit);

    process.exit(grand.failed > 0 ? 1 : 0);
  }

  if (autoOnly && flowHasHumanInput(args[0])) {
    console.log(`\n  ⏭  Skipping "${args[0]}" — contains human-input steps (--auto)\n`);
    process.exit(0);
  }

  const result = await runFlow(args[0], envName);
  if (report || junit) saveReport(result, junit);
  process.exit(result.totalFailed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
