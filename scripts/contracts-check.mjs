// Fails when the contracts are inconsistent or generated code is stale:
//   - contracts/VERSION equals info.version of both OpenAPI files
//   - src/contracts/*.gen.ts equals a fresh generation from the specs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const version = readFileSync(path.join(root, 'contracts/VERSION'), 'utf8').trim();
let failed = false;

for (const spec of ['core-public.openapi.yaml', 'judge.openapi.yaml']) {
  const text = readFileSync(path.join(root, 'contracts', spec), 'utf8');
  const match = text.match(/^info:\n(?:\s+.*\n)*?\s+version:\s*(\S+)/m);
  if (!match || match[1] !== version) {
    console.error(
      `contracts/${spec} info.version (${match?.[1]}) does not match contracts/VERSION (${version})`
    );
    failed = true;
  }
}

const scratch = mkdtempSync(path.join(tmpdir(), 'verdale-contracts-'));
for (const [spec, output] of [
  ['core-public.openapi.yaml', 'core-public.gen.ts'],
  ['judge.openapi.yaml', 'judge.gen.ts'],
]) {
  const fresh = path.join(scratch, output);
  execFileSync('npx', ['openapi-typescript', path.join(root, 'contracts', spec), '-o', fresh], {
    stdio: 'ignore',
  });
  execFileSync('npx', ['prettier', '--config', path.join(root, '.prettierrc'), '--write', fresh], {
    stdio: 'ignore',
    cwd: root,
  });
  const committed = readFileSync(path.join(root, 'src/contracts', output), 'utf8');
  if (readFileSync(fresh, 'utf8') !== committed) {
    console.error(`src/contracts/${output} is out of date: run npm run contracts:generate`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`Contracts ${version}: versions consistent, generated types up to date`);
