import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stdout } from 'node:process';

const ansiEnabled = Boolean(stdout.isTTY && !process.env.NO_COLOR);
const HEADER_ROWS = 9;

function color(value: string, code: number): string {
  return ansiEnabled ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function headerLines(projectRoot: string): string[] {
  const logo = [
    '███╗   ██╗ ██████╗ ██╗   ██╗ █████╗',
    '████╗  ██║██╔═══██╗██║   ██║██╔══██╗',
    '██╔██╗ ██║██║   ██║██║   ██║███████║',
    '██║╚██╗██║██║   ██║╚██╗ ██╔╝██╔══██║',
    '██║ ╚████║╚██████╔╝ ╚████╔╝ ██║  ██║',
    '╚═╝  ╚═══╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝',
  ].join('\n');
  const width = Math.max(24, (stdout.columns ?? 80) - 2);
  const shortPath = Array.from(projectRoot).length > width ? `…${Array.from(projectRoot).slice(-(width - 1)).join('')}` : projectRoot;
  return [
    ...logo.split('\n').map((line) => color(line, 36)),
    `${color('NOVA', 1)} ${color('local coding agent', 90)}`,
    color(shortPath, 90),
    color('─'.repeat(Math.min(width, 72)), 90),
  ];
}

export function renderBrand(projectRoot: string): void {
  if (!stdout.isTTY || process.env.TERM === 'dumb' || !stdout.rows || stdout.rows < HEADER_ROWS + 4) {
    console.log(headerLines(projectRoot).join('\n'));
    return;
  }

  const drawHeader = (clearBody = false) => {
    const rows = headerLines(projectRoot);
    if (!clearBody) stdout.write('\u001b[s');
    stdout.write('\u001b[r');
    rows.forEach((line, index) => stdout.write(`\u001b[${index + 1};1H\u001b[2K${line}`));
    for (let row = rows.length + 1; row <= HEADER_ROWS; row += 1) stdout.write(`\u001b[${row};1H\u001b[2K`);
    if (clearBody) stdout.write(`\u001b[${HEADER_ROWS + 1};1H\u001b[J`);
    stdout.write(`\u001b[${HEADER_ROWS + 1};${stdout.rows}r`);
    stdout.write(clearBody ? `\u001b[${HEADER_ROWS + 1};1H` : '\u001b[u');
  };

  drawHeader(true);
  const onResize = () => drawHeader();
  stdout.on('resize', onResize);
  process.once('exit', () => {
    stdout.removeListener('resize', onResize);
    stdout.write('\u001b[r\u001b[?25h');
  });
}

export function renderStatus(status: string, detail?: string): void {
  const code = status === 'DONE' || status === 'write' ? 32 : status === 'ERROR' ? 31 : 36;
  console.log(`${color('●', code)} ${color(status, 1)}${detail ? ` ${color('·', 90)} ${detail}` : ''}`);
}

export function renderEvent(action: 'read' | 'write', filePath: string): void {
  const label = action === 'read' ? color('read', 36) : color('write', 32);
  console.log(`  ${color('◆', 90)} ${label} ${filePath}`);
}

export function startThinking(): () => void {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  if (!stdout.isTTY) {
    console.log(color('thinking…', 36));
    return () => undefined;
  }

  let frame = 0;
  const draw = () => stdout.write(`\r\u001b[2K${color(frames[frame++ % frames.length]!, 36)} ${color('thinking', 1)}`);
  draw();
  const timer = setInterval(draw, 90);
  timer.unref();
  return () => {
    clearInterval(timer);
    stdout.write('\r\u001b[2K');
  };
}

export function renderDone(reportPaths: string[], projectRoot: string): void {
  renderStatus('DONE', 'session terminée');
  if (reportPaths.length === 0) return;
  console.log(color('Changements :', 90));
  for (const reportPath of reportPaths) {
    const label = path.relative(projectRoot, reportPath);
    const safeLabel = label.replace(/[\u001b\u0000-\u001f]/g, '');
    const link = `\u001b]8;;${pathToFileURL(reportPath).href}\u001b\\${safeLabel}\u001b]8;;\u001b\\`;
    console.log(`  ${color('↗', 36)} ${link}`);
  }
}

export function renderSummary(summary: string): void {
  const width = Math.max(48, Math.min((stdout.columns ?? 96) - 4, 100));
  const normalized = summary.trim().replace(/\s+(?=(?:\d{1,2}[.)]|[-*•])\s+)/g, '\n');
  console.log(`\n${color('summary', 36)}`);
  for (const paragraph of normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const match = paragraph.match(/^((?:\d{1,2}[.)]|[-*•])\s+)(.*)$/);
    const prefix = match?.[1] ?? '';
    const content = match?.[2] ?? paragraph;
    const indent = prefix ? ' '.repeat(prefix.length) : '';
    let line = prefix;
    for (const word of content.split(/\s+/)) {
      const candidate = `${line}${line && !line.endsWith(' ') ? ' ' : ''}${word}`;
      if (Array.from(candidate).length > width && line.trim()) {
        console.log(`  ${line}`);
        line = `${indent}${word}`;
      } else {
        line = candidate;
      }
    }
    if (line.trim()) console.log(`  ${line}`);
  }
}
