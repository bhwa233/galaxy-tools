// Real isolated processes exercise the token/lease boundary and normal EOF cleanup. No service installation or elevation.
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../..');
const stage = path.resolve(process.argv[2] || path.join(repo, 'packages/official/traffic/native'));
const run = path.join(repo, 'local-build/spark233/native-traffic/runs', crypto.randomUUID());
const pipe = `spark233-traffic-test-${crypto.randomUUID()}`;
const children = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  await fs.mkdir(run, { recursive: true });
  const service = spawn(path.join(stage, 'spark233.TrafficService.exe'), ['--console', '--isolate', path.join(run, 'data'), '--pipe', pipe], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.push(service);
  let diagnostic = '';
  service.stderr.on('data', chunk => diagnostic += chunk.toString());
  const start = Date.now();
  while (!diagnostic.includes('traffic-isolated-ready') && service.exitCode === null && Date.now() - start < 10000) await delay(50);
  assert(diagnostic.includes('traffic-isolated-ready'), `isolated service failed: ${diagnostic}`);
  let bridge = spawn(path.join(stage, 'spark233.TrafficClient.exe'), ['--bridge', '--isolated-pipe', pipe], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.push(bridge);
  const pending = new Map(); let buffer = '', bridgeDiagnostic = '';
  bridge.stderr.on('data', chunk => bridgeDiagnostic += chunk.toString());
  const parseOutput = chunk => {
    buffer += chunk.toString('utf8');
    for (;;) { const index = buffer.indexOf('\n'); if (index < 0) break; const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue; const message = JSON.parse(line); const entry = pending.get(message.requestId); if (entry) { clearTimeout(entry.timer); pending.delete(message.requestId); entry.resolve(message); } }
  };
  bridge.stdout.on('data', parseOutput);
  const identity = { protocol: 1, owner: { pluginId: 'official.traffic', version: '1.0.0', instanceId: crypto.randomUUID() }, sessionId: crypto.randomUUID() };
  const request = (type, extra = {}) => new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID(); const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${type} timed out; ${bridgeDiagnostic}; ${diagnostic}`)); }, 15000);
    pending.set(requestId, { resolve, reject, timer }); bridge.stdin.write(JSON.stringify({ ...identity, requestId, type, ...extra }) + '\n');
  });
  const query = async (command, fields = {}, expectOk = true) => {
    const response = await request('query', { activation: { parameters: { command, scope: 'own', ...fields } } });
    assert.equal(response.ok, expectOk, JSON.stringify(response)); return response.ok ? response.value : response.error;
  };
  const init = await request('init', { entryId: 'main', dataDir: path.join(run, 'plugin'), cacheDir: path.join(run, 'cache') });
  assert.equal(init.value.pid, bridge.pid);
  const initial = await query('status'); assert.equal(initial.serviceAvailable, true, diagnostic); assert.equal(initial.enabled, false); assert.equal(initial.collecting, false); assert.equal(initial.hasLease, false);
  const denied = await query('history', { sid: 'S-1-5-18' }, false); assert.match(denied, /untrusted-parameter/);
  const enabled = await query('enable'); assert.equal(enabled.enabled, true); assert.equal(enabled.hasLease, true);
  await delay(2300);
  const snapshot = await query('snapshot', { limit: 2 });
  assert.equal(snapshot.source, 'etw'); assert(Array.isArray(snapshot.processes));
  assert(snapshot.nextCursor, 'small snapshot page should expose opaque cursor');
  const page = await query('snapshot', { limit: 2, cursor: snapshot.nextCursor });
  assert.equal(page.snapshotId, snapshot.snapshotId); assert(!page.processes.some(row => snapshot.processes.some(old => old.processInstanceId === row.processInstanceId)));
  const prepared = await request('prepareStop', { reason: 'app-exit' }); assert.equal(prepared.value.ok, true);
  const resumed = await query('status'); assert.equal(resumed.hasLease, true);
  await delay(1500);
  await request('prepareStop', { reason: 'app-exit' });
  const confirmation = await query('clearHistory', {}, false); assert.match(confirmation, /confirmation/);
  const history = await query('history', { from: new Date(Date.now() - 3600000).toISOString(), to: new Date().toISOString() }); assert(Array.isArray(history.rows));
  const latest = history.coverage.filter(segment => segment.reason.startsWith('etw-unavailable')).at(-1);
  if (snapshot.quality.state === 'unavailable') assert(latest && Date.parse(latest.end) > Date.parse(snapshot.windowEnd), 'coverage must advance after a completed flush');
  const cleared = await query('clearHistory', { confirm: true }); assert.equal(cleared.cleared, true);
  // Closing the normal-user bridge must release its lease but preserve persisted user intent.
  bridge.stdin.end(); if (bridge.exitCode === null) await once(bridge, 'exit'); assert.equal(bridge.exitCode, 0, bridgeDiagnostic);
  bridge = spawn(path.join(stage, 'spark233.TrafficClient.exe'), ['--bridge', '--isolated-pipe', pipe], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); children.push(bridge);
  bridge.stderr.on('data', chunk => bridgeDiagnostic += chunk.toString()); bridge.stdout.on('data', parseOutput);
  await request('init', { entryId: 'main', dataDir: path.join(run, 'plugin'), cacheDir: path.join(run, 'cache') });
  const afterEof = await query('status'); assert.equal(afterEof.enabled, true); assert.equal(afterEof.hasLease, false); assert.equal(afterEof.collecting, false);
  const explicitResume = await query('enable'); assert.equal(explicitResume.hasLease, true);
  const disabled = await query('disable'); assert.equal(disabled.enabled, false); assert.equal(disabled.hasLease, false);
  const stopped = await request('stop'); assert.equal(stopped.value.stopped, true);
  if (bridge.exitCode === null) await once(bridge, 'exit'); assert.equal(bridge.exitCode, 0, bridgeDiagnostic);
  service.stdin.end(); if (service.exitCode === null) await once(service, 'exit'); assert.equal(service.exitCode, 0, diagnostic);
  const report = { ok: true, run, checks: ['real native-v1 PID handshake', 'init does not collect', 'pipe caller scope rejects claimed SID', 'enable acquires lease', 'snapshot cursor pins generation without repeated rows', 'prepareStop resumes with lease', 'coverage advances across successful flushes', 'history requires explicit clear confirmation', 'history query and clear', 'bridge EOF releases lease and status remains pure read', 'disable revokes lease', 'normal stop and service EOF flush'], collectorQuality: snapshot.quality, processes: snapshot.processes.length, serviceDiagnostic: diagnostic.trim(), bridgeDiagnostic: bridgeDiagnostic.trim() };
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { for (const child of children) if (child.exitCode === null) { child.stdin.end(); await Promise.race([once(child, 'exit'), delay(3000)]); if (child.exitCode === null) child.kill(); } });
