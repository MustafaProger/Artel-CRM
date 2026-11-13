// Run inside the active CRM container so the normal store transaction can coordinate with other writes.
import { effectiveSections } from '../web/src/auth-model';
import { login, saveUser } from '../server/auth';
import { loadSnapshot } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';

process.umask(0o077);
const [loginName, name] = process.argv.slice(2);
const { ARTEL_SNAPSHOT_DIR, ARTEL_STORE_DIR } = process.env;
if (!loginName || !name || !ARTEL_SNAPSHOT_DIR || !ARTEL_STORE_DIR) {
  throw new Error('Provide login, display name, runtime paths and password on stdin.');
}

process.stdin.setEncoding('utf8');
let password = '';
for await (const chunk of process.stdin) {
  password += chunk;
  if (password.length > 258) throw new Error('Invalid password length.');
}
password = password.replace(/\r?\n$/, '');
const base = await loadSnapshot(ARTEL_SNAPSHOT_DIR);
const source = base.provenance.sourceSha256;
const store = new OperationsStore(ARTEL_STORE_DIR);
const account = await store.mutate(source, async data => {
  const existing = data.accounts?.users.find(user => user.login === loginName);
  if (existing) {
    const result = await login(structuredClone(data), { login: loginName, password });
    if (existing.role !== 'developer' || existing.name !== name || result.status !== 200) {
      throw new Error('Login is already reserved by a different account or credential.');
    }
    return { result: { id: existing.id, created: false }, changed: false };
  }
  if (!data.accounts?.users.some(user => user.active && (user.role === 'director' || user.role === 'developer'))) {
    throw new Error('Complete the initial CRM setup first.');
  }
  const user = await saveUser(data, currentSnapshot(base, data, false), {
    name, login: loginName, password, role: 'developer',
  });
  return { result: { id: user.id, created: true }, changed: true };
});

const saved = await store.readAuth(source);
const result = await login(saved, { login: loginName, password });
if (result.status !== 200 || result.user?.id !== account.id || result.user.role !== 'developer') {
  throw new Error('Developer login could not be verified.');
}
console.log(JSON.stringify({ created: account.created, role: result.user.role, sections: effectiveSections(result.user).length }));
