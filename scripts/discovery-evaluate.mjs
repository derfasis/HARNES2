import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoveryEvaluationContexts, evaluateDiscoveryPredictions } from '../business/discovery-evaluation.mjs';

// Standalone/offline: never load local runtime configuration or launch a worker.
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i], value = args[i + 1];
  if (!['--corpus', '--predictions', '--contexts', '--report'].includes(key) || !value || value.startsWith('--') || options[key]) {
    throw new Error('Usage: node scripts/discovery-evaluate.mjs [--corpus file] [--predictions file] [--contexts file] [--report file]');
  }
  options[key] = value;
}
const corpusPath = path.resolve(options['--corpus'] ?? fileURLToPath(new URL('../benchmarks/discovery-v1/corpus.json', import.meta.url)));
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const corpus = read(corpusPath);
const predictions = options['--predictions'] ? read(path.resolve(options['--predictions'])) : null;
const outputs = [options['--contexts'], options['--report']].filter(Boolean).map(filename => path.resolve(filename));
const inputs = [corpusPath, ...(options['--predictions'] ? [path.resolve(options['--predictions'])] : [])];
if (new Set(outputs).size !== outputs.length || outputs.some(filename => inputs.includes(filename))) {
  throw new Error('Output paths must be distinct and must not overwrite an input.');
}
const report = evaluateDiscoveryPredictions(corpus, predictions);
const write = (filename, value) => fs.writeFileSync(path.resolve(filename), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
if (options['--contexts']) write(options['--contexts'], discoveryEvaluationContexts(corpus));
if (options['--report']) write(options['--report'], report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
