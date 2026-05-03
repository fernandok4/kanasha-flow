#!/usr/bin/env node
'use strict';

const newman = require('newman');
const yaml   = require('js-yaml');
const fs     = require('fs');
const path   = require('path');

const ROOT       = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, '.env-state.json');

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
  return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
}

function saveState(vars) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(vars, null, 2));
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
  return JSON.parse(JSON.stringify(req)); // deep clone
}

function applyBodyOverride(request, overrides, vars) {
  if (!overrides || !request.request.body) return;
  let raw = request.request.body.raw || '{}';
  // resolve {{vars}} in the existing body first
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


function runRequestStep(step, vars, collections) {
  const { collection: collName, folder, request: reqName, body_override, extract } = step;

  const collection = collections[collName];
  if (!collection) throw new Error(`Collection "${collName}" not loaded`);

  const request = findRequest(collection, folder, reqName);
  if (body_override) applyBodyOverride(request, body_override, vars);

  const miniCollection = {
    info: { ...collection.info, name: `[flow] ${reqName}` },
    item: [request]
  };

  return new Promise((resolve, reject) => {
    newman.run({
      collection: miniCollection,
      environment: { id: 'flow-env', values: buildEnvValues(vars) },
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

// ─── flow runner ─────────────────────────────────────────────────────────────

function flowHasHumanInput(flowFile) {
  const flowPath = path.isAbsolute(flowFile)
    ? flowFile
    : path.join(ROOT, 'tests', flowFile);
  if (!fs.existsSync(flowPath)) return false;
  const flow = yaml.load(fs.readFileSync(flowPath, 'utf8'));
  return (flow.steps || []).some(s => s.type === 'human-input');
}

async function runFlow(flowFile, envName = 'local') {
  const flowPath = path.isAbsolute(flowFile)
    ? flowFile
    : path.join(ROOT, 'tests', flowFile);

  if (!fs.existsSync(flowPath)) throw new Error(`Flow file not found: ${flowPath}`);

  const flow = yaml.load(fs.readFileSync(flowPath, 'utf8'));

  console.log(`\n${'═'.repeat(62)}`);
  console.log(` 🧪 ${flow.name}`);
  if (flow.description) console.log(` ${flow.description}`);
  console.log('═'.repeat(62));

  // Build env: environment file + persisted state
  const env = loadEnvironment(envName);
  const vars = {};
  for (const v of env.values) {
    if (v.enabled && v.value !== '') vars[v.key] = v.value;
  }
  Object.assign(vars, loadState());

  const collections = loadAllCollections();

  let totalPassed = 0;
  let totalFailed = 0;
  const stepResults = [];

  for (const step of flow.steps) {
    const label = step.name || `${step.folder} / ${step.request}`;
    process.stdout.write(`\n  ▶ ${label}\n`);

    try {
      const result = step.type === 'human-input'
        ? await runHumanInputStep(step, vars)
        : await runRequestStep(step, vars, collections);

      totalPassed += result.passed;
      totalFailed += result.failed;
      const ok = !result.hasFailed && result.failed === 0;
      console.log(`     ${ok ? '✓ passed' : '✗ failed'} (${result.passed} assertions)`);
      stepResults.push({ step: label, ok, passed: result.passed, failed: result.failed });

      if (result.hasFailed && flow.stop_on_failure !== false) {
        console.log(`\n  ⛔ Stopping flow — step failed and stop_on_failure is enabled`);
        break;
      }
    } catch (e) {
      totalFailed++;
      console.log(`     ✗ ERROR: ${e.message}`);
      stepResults.push({ step: label, ok: false, error: e.message });
      if (flow.stop_on_failure !== false) {
        console.log(`\n  ⛔ Stopping flow — unhandled error`);
        break;
      }
    }
  }

  // Persist state for subsequent flows
  saveState(vars);

  console.log(`\n${'─'.repeat(62)}`);
  console.log(` ✅ ${totalPassed} passed   ❌ ${totalFailed} failed`);
  console.log('─'.repeat(62));

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

  const stepRows = steps => steps.map(s => `
      <tr class="${s.ok ? '' : 'fail-row'}">
        <td>${esc(s.step)}</td>
        <td class="status ${s.ok ? 'ok' : 'ko'}">${s.ok ? '✓ passed' : '✗ failed'}</td>
        <td class="num">${s.passed ?? 0}</td>
        <td class="num">${s.failed ?? 0}</td>
        <td class="err">${esc(s.error ?? '')}</td>
      </tr>`).join('');

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
    section{}
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

function saveReport(flowResult) {
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
}

function saveCombinedReport(flowResults) {
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
  node runner.js <flow.yml> [environment] [--auto] [--report]
  node runner.js --all [environment] [--auto] [--report]
  node runner.js --request <collection> <folder> <request> [environment]
  node runner.js --list

Examples:
  node runner.js 01-setup.yml
  node runner.js 01-setup.yml --report
  node runner.js --all local
  node runner.js --all --auto
  node runner.js --all --auto --report
  node runner.js --request authentication-service "OAuth2" "Get Company Token"
  node runner.js --request communication-service "Challenges" "Validate Challenge - Success" local
  node runner.js --list

Flags:
  --auto     Pula flows que contém steps human-input (apenas testes automatizados)
  --report   Gera relatório JSON + HTML em reports/ após a execução
`);
    process.exit(0);
  }

  if (args[0] === '--list') {
    listRequests();
    process.exit(0);
  }

  if (args[0] === '--set') {
    const [, key, value] = args;
    if (!key || value === undefined) {
      console.error('Usage: --set <key> <value>');
      process.exit(1);
    }
    const state = loadState();
    state[key] = value;
    saveState(state);
    console.log(`✓ ${key} = ${value}`);
    process.exit(0);
  }

  if (args[0] === '--get') {
    const state = loadState();
    if (args[1]) {
      const val = state[args[1]];
      console.log(val !== undefined ? `${args[1]} = ${val}` : `${args[1]} não encontrado no estado`);
    } else {
      console.log(JSON.stringify(state, null, 2));
    }
    process.exit(0);
  }

  if (args[0] === '--request') {
    const [, collectionName, folderName, requestName, envName] = args;
    if (!collectionName || !folderName || !requestName) {
      console.error('Usage: --request <collection> <folder> <request> [environment]');
      process.exit(1);
    }
    const result = await runSingleRequest(collectionName, folderName, requestName, envName || 'local');
    process.exit(result.hasFailed ? 1 : 0);
  }

  const report   = args.includes('--report');
  const autoOnly = args.includes('--auto');
  const envName  = args.find(a => !a.startsWith('--') && !a.endsWith('.yml')) || 'local';

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

    if (report) saveCombinedReport(flowResults);

    process.exit(grand.failed > 0 ? 1 : 0);
  }

  if (autoOnly && flowHasHumanInput(args[0])) {
    console.log(`\n  ⏭  Skipping "${args[0]}" — contains human-input steps (--auto)\n`);
    process.exit(0);
  }

  const result = await runFlow(args[0], envName);
  if (report) saveReport(result);
  process.exit(result.totalFailed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
