import * as printables from './printables.js';
import * as thingiverse from './thingiverse.js';
import * as makerworld from './makerworld.js';

/** Registry order doubles as the display order of the source rail in the UI. */
export const sources = [printables, makerworld, thingiverse];

export const sourceIds = sources.map((source) => source.id);

export function getSource(id) {
  return sources.find((source) => source.id === id);
}

export function describeSources() {
  return sources.map((source) => ({
    id: source.id,
    label: source.label,
    homepage: source.homepage,
    configured: source.isConfigured ? source.isConfigured() : true,
  }));
}
