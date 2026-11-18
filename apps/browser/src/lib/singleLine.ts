const LINE_BREAK = /[\r\n\u2028\u2029\u0085\v\f]/;
const LINE_BREAKS = /\s*[\r\n\u2028\u2029\u0085\v\f]+\s*/g;

export const singleLine = (text: string) => (LINE_BREAK.test(text) ? text.replace(LINE_BREAKS, " ").trim() : text);
