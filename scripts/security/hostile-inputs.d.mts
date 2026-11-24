export type Hostile = { id: string; value: unknown };
export type HostileString = { id: string; value: string };

export declare const LINE_BREAKS: Record<string, string>;
export declare const CONTROLS: Record<string, string>;
export declare const FILTER_SYNTAX: Record<string, string>;
export declare const URL_SCHEMES: Record<string, string>;
export declare const PATHS: Record<string, string>;
export declare const PROTOTYPE_KEYS: readonly string[];
export declare const OVERLONG: Record<string, string>;
export declare const WRONG_TYPES: Record<string, unknown>;
export declare const HOSTILE_STRINGS: readonly HostileString[];
export declare const HOSTILE_VALUES: readonly Hostile[];
export declare const LINE_TERMINATORS: RegExp;
export declare const UBLOCK_LINE_BREAK: RegExp;
export declare function embedded(value: string, before?: string, after?: string): string[];
