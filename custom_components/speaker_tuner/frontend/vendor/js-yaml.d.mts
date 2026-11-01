// Types for the parts of js-yaml 4.1.0 the app uses.
export class Type {
  constructor(tag: string, options: { kind: 'scalar' | 'sequence' | 'mapping'; construct?: (data: any) => any; resolve?: (data: any) => boolean });
}
export class Schema {
  extend(types: Type[]): Schema;
}
export const DEFAULT_SCHEMA: Schema;
export function load(text: string, options?: { schema?: Schema; filename?: string; json?: boolean }): unknown;
declare const _default: { Type: typeof Type; DEFAULT_SCHEMA: Schema; load: typeof load };
export default _default;
