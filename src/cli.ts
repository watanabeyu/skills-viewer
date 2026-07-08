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
start({
  port: portIdx >= 0 ? Number(args[portIdx + 1]) : 4763,
  open: !args.includes('--no-open'),
  cwd: process.cwd(),
});
