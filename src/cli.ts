#!/usr/bin/env node
import { start } from './server';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`skills-viewer — Claude Code の skills / commands / agents / hooks をブラウザで一望

Usage: skills-viewer [options]

Options:
  --port <n>   ポート指定 (既定 4763、使用中なら +1)
  --no-open    ブラウザを自動で開かない
  -h, --help   このヘルプ`);
  process.exit(0);
}

const portIdx = args.indexOf('--port');
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 4763;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('--port には 0〜65535 の整数を指定してください');
  process.exit(1);
}
start({
  port,
  open: !args.includes('--no-open'),
  cwd: process.cwd(),
});
