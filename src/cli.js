#!/usr/bin/env node
/**
 * 命令行入口:读取备份清单 JSON,输出恢复链验证报告。
 *
 * 用法:
 *   node src/cli.js <manifest.json>
 *   node src/cli.js <manifest.json> --target <ISO时间> [--log-position <N>]
 *
 * 本工具只读取清单与摘要信息,不执行真实恢复。
 */
import { readFile } from 'node:fs/promises';
import { buildReport, evaluateTarget, validateManifest } from './validator.js';

function parseArgs(argv) {
  const args = { manifestPath: null, target: null, logPosition: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target') {
      args.target = argv[++i] ?? null;
    } else if (arg === '--log-position') {
      args.logPosition = Number(argv[++i]);
    } else if (!arg.startsWith('--') && args.manifestPath === null) {
      args.manifestPath = arg;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifestPath) {
    console.error('用法: node src/cli.js <manifest.json> [--target <ISO时间> --log-position <N>]');
    process.exitCode = 2;
    return;
  }

  const manifest = JSON.parse(await readFile(args.manifestPath, 'utf8'));
  const report = buildReport(manifest);

  if (args.target) {
    const target = { time: args.target };
    if (Number.isFinite(args.logPosition)) {
      target.logPosition = args.logPosition;
    }
    report.targets = [...report.targets, evaluateTarget(validateManifest(manifest), target)];
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(`验证失败: ${error.message}`);
  process.exitCode = 1;
});
