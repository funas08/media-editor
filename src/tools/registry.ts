// ツールの登録

import type { Tool } from './Tool';

const tools: Tool[] = [];

export function registerTool(tool: Tool): void {
  if (tools.some((t) => t.id === tool.id)) throw new Error(`ツール ${tool.id} は登録済みです`);
  tools.push(tool);
  tools.sort((a, b) => a.order - b.order);
}

export function getTools(): readonly Tool[] {
  return tools;
}

export function getTool(id: string): Tool | undefined {
  return tools.find((t) => t.id === id);
}
