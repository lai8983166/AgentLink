import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const choices = [process.env.AGENTLINK_CLAUDE_BINARY,
  ...(process.platform === 'win32' ? [join(homedir(), '.local/bin/claude.exe'), join(process.env.APPDATA ?? '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe')] : [])];
const binary = choices.find(p => p && existsSync(p)) ?? 'claude';
const version = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true });
if (version.status !== 0) throw new Error('找不到 Claude Code，可设置 AGENTLINK_CLAUDE_BINARY 指定可执行文件');
const parts = version.stdout.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
if (!parts || parts[0] * 1000000 + parts[1] * 10000 + parts[2] < 2010314) throw new Error('请使用 Claude Code 2.1.314 或更新版本；此命令不会更新 CLI');
for (const args of [
  ['plugin', 'validate', '--strict', join(root, 'claude-code')],
  ['plugin', 'install', 'agentlink', '--marketplace', root, '--scope', 'user'],
  ['plugin', 'update', 'agentlink@agentlink-local'],
]) {
  const result = spawnSync(binary, args, { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('AgentLink Claude 插件已安装。新终端继续运行 claude；已有会话输入 /reload-plugins 加载。');
console.log('需运行新版 AgentLink 后台；插件只通过本机连接，不需要向 Claude 填入手机配对 token。');
