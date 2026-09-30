// Result types with the same names, fields and behaviour as @e2b/code-interpreter,
// so code that reads `execution.text`, `execution.logs.stdout` or
// `execution.error.traceback` does not change when the import does.

export class OutputMessage {
  constructor(line, timestamp, error) { this.line = line; this.timestamp = timestamp; this.error = error; }
  toString() { return this.line; }
}

export class ExecutionError {
  constructor(name, value, traceback) { this.name = name; this.value = value; this.traceback = traceback; }
}

const KNOWN = new Set(['plain', 'html', 'markdown', 'svg', 'png', 'jpeg', 'pdf', 'latex', 'json',
                       'javascript', 'data', 'chart', 'extra', 'text']);

export class Result {
  constructor(rawData, isMainResult) {
    const data = { ...rawData };
    delete data.type; delete data.is_main_result;
    this.isMainResult = isMainResult;
    this.text = data.text; this.html = data.html; this.markdown = data.markdown; this.svg = data.svg;
    this.png = data.png; this.jpeg = data.jpeg; this.pdf = data.pdf; this.latex = data.latex;
    this.json = data.json; this.javascript = data.javascript;
    this.raw = data; this.data = data.data; this.chart = data.chart;
    this.extra = {};
    for (const k of Object.keys(data)) if (!KNOWN.has(k)) this.extra[k] = data[k];
  }
  formats() {
    const f = [];
    for (const k of ['html', 'markdown', 'svg', 'png', 'jpeg', 'pdf', 'latex', 'json', 'javascript', 'data'])
      if (this[k]) f.push(k);
    return f.concat(Object.keys(this.extra));
  }
  toJSON() {
    return { text: this.text, html: this.html, markdown: this.markdown, svg: this.svg, png: this.png,
             jpeg: this.jpeg, pdf: this.pdf, latex: this.latex, json: this.json, javascript: this.javascript,
             ...(Object.keys(this.extra).length ? { extra: this.extra } : {}) };
  }
}

export class Execution {
  constructor(results = [], logs = { stdout: [], stderr: [] }, error, executionCount) {
    this.results = results; this.logs = logs; this.error = error; this.executionCount = executionCount;
  }
  /** Text of the MAIN result - the cell's last expression - not what it printed. */
  get text() {
    for (const r of this.results) if (r.isMainResult) return r.text;
    return undefined;
  }
  toJSON() { return { results: this.results, logs: this.logs, error: this.error }; }
}
