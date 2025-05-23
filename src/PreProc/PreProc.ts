import { dirname } from "jsr:@std/path";
import { exists } from "jsr:@std/fs/exists";
import { FileLineStream, Tokenstream } from "./Streams.ts";
import * as path from "jsr:@std/path";

export default class PreProc {
  private _state: PreProcStateInterface;
  private file: string;
  private output: string[] = [];
  private config: PreProcConfig;
  private fileDepth: number;
  private iter: FileLineStream;
  private ifDepth: number = 0;
  private relative: string;
  constructor(
    file: string,
    state: PreProcStateInterface,
    config: PreProcConfig,
    depth: number,
    iterator: FileLineStream,
  ) {
    this.file = file;
    this._state = state;
    this.config = config;
    this.fileDepth = depth;
    this.iter = iterator;
    this.relative = path.relative(this.config.root || file, file);
  }

  static async createFromFile(
    file: string,
    state: PreProcStateInterface,
    config: PreProcConfig,
    depth: number,
  ): Promise<PreProc> {
    return new PreProc(
      file,
      state,
      config,
      depth,
      await FileLineStream.createFromFile(file),
    );
  }

  async run(): Promise<string> {
    this.output = [];
    this.outputLine();
    this.state.addFile(this.file);
    while (this.iter.peekValid()) {
      const line = this.iter.next() as string;
      const res = await this.process(line);
      if (res !== false) {
        const filled = this.replaceDefines(res);
        const lines = filled.split("\n");
        this.output.push(lines.shift() as string);
        if (lines.length) {
          this.iter.push(lines);
        }
      }
    }
    this.clean();

    return this.output.join("\n");
  }

  private outputLine() {
    this.output.push(this.getLineComment());
  }

  private getLineComment() {
    return [
      this.single,
      "MAP",
      this.relative,
      this.iter.trueLine + 1,
      this.fileDepth - 1,
    ].join(" : ");
  }

  private clean(): void {
    this.output = this.output.map((l) => l.trimEnd());

    if (this.cleanComments) {
      this.output = this.output.filter((line) =>
        !line.trimStart().startsWith(this.single)
      );
    }

    if (this.collapseEmpty) {
      this.output = this.output.filter((line, i) =>
        i < 1 || line != "" || line != this.output[i - 1]
      );
    }

    if (this.trim) {
      while (this.output[0] == "") this.output.shift();
      while (this.output[this.output.length - 1] == "") this.output.pop();
    }
  }

  get state(): PreProcStateInterface {
    return this._state;
  }

  private replaceDefines(line: string): string {
    const stream = new Tokenstream(line, this.config.language);

    const out: string[] = [];

    let next = stream.next();

    let commented = false;

    while (next) {
      if (next == this.language.comments.single) commented = true;
      const def = commented ? null : this.readState(next);
      if (def) {
        if (typeof def == "string") next = def;
        else {
          const args = [];
          let depth = 1;
          let arg = "";
          next = stream.next();
          if (next != "(") {
            this.error("Defined function call not followed by '(");
          }
          next = stream.next();
          while (next) {
            if (next == "(") {
              depth++;
            } else if (next == ")") {
              depth--;
              if (depth == 0) {
                if (arg) args.push(arg);
                break;
              }
            }
            if (depth == 1 && next == ",") {
              args.push(arg);
              arg = "";
            } else {
              arg += next;
            }
            next = stream.next();
          }
          next = def(args);
        }
      }
      if (next) {
        out.push(next);
      }
      next = stream.next();
    }

    return out.join("");
  }

  private get language(): LanguageConfig {
    return this.config.language;
  }

  private get verbose(): boolean {
    return !!(this.config.options["verbose"] ?? false);
  }

  private get collapseEmpty(): boolean {
    return !!(this.config.options["clean-empty-lines"] ?? false);
  }

  private get cleanComments(): boolean {
    return !!(this.config.options["clean-comments"] ?? false);
  }

  private get trim(): boolean {
    return !!(this.config.options["clean-trim"] ?? false);
  }

  private readLineEndsWithEscape(line: string): string {
    line = line.trimEnd();
    if (line.charAt(line.length - 1) == "\\") {
      while (this.iter.peekValid()) {
        let nLine = this.iter.next() as string;
        line = line.substring(0, line.length - 1).trimEnd();
        if (this.language.leadCharCommented) {
          nLine = nLine.trimStart();
          if (!nLine.startsWith(this.single)) {
            throw `Trying to read multiline def without preceeding '${this.single}'`;
          }
          nLine = nLine.substring(2);
        }
        line += "\n" + nLine.trimEnd();
        if (line.charAt(line.length - 1) != "\\") {
          break;
        }
      }
    }
    return line;
  }

  private async process(line: string): Promise<string | false> {
    const res = this.getLineCmd(line);
    if (res === false) return line;
    const [cmd, arg] = res;
    switch (cmd) {
      case "define": {
        let sp = arg.indexOf(" ");
        if (sp < 0) sp = arg.length;
        this.state.store(
          arg.substring(0, sp).trim(),
          arg.substring(sp).trim(),
        );
        break;
      }
      case "ifdef": {
        if (this.readState(arg) === null) {
          this.readLinesTillOutOfIf();
        } else this.ifDepth++;
        break;
      }
      case "ifndef": {
        if (this.readState(arg) !== null) {
          this.readLinesTillOutOfIf();
        } else this.ifDepth++;
        break;
      }
      case "includeonce":
      case "include": {
        const fileArg = this.cleanIncludeArg(arg);
        let file = dirname(this.file) + "/" + this.cleanIncludeArg(arg);
        if (!(await exists(file))) {
          file += "." + this.file.split(".").pop();
          if (!(await exists(file))) {
            this.error(`Cannot find file ${fileArg}\nTried: ${file}`);
          }
        }
        file = path.resolve(file);
        if (cmd == "includeonce") {
          if (this.state.files.includes(file)) {
            return this.verbose
              ? `${this.single} <${cmd} file="${file}" skipped/>`
              : false;
          }
        }
        const preproc = await PreProc.createFromFile(
          file,
          this.state,
          this.config,
          this.fileDepth + 1,
        );
        const str = await preproc.run();
        if (str) {
          if (this.verbose) {
            this.output.push(this.single + `<${cmd} file="${file}">\n${str}`);
          }
          this.output.push(str);
          if (this.verbose) this.output.push(`${this.single} </${cmd}>`);
          return this.getLineComment();
        } else {
          return this.verbose
            ? `${this.single} <${cmd} file="${file}"/>`
            : false;
        }
      }
      case "else":
      case "elseif": {
        this.error(`Unmatched #${cmd}`);
        break;
      }
      case "endif": {
        if (this.ifDepth) this.ifDepth--;
        else this.error("Unmatched endif");
        break;
      }
      default: {
        console.log(`CMD: |${cmd}| = |${arg}|`);
        break;
      }
    }
    return false;
  }

  private cleanIncludeArg(inc: string): string {
    const frst = inc.charAt(0);
    const str = this.language.string.find((lang) => lang.char == frst);
    if (str) {
      let end = inc.length;
      if (inc.charAt(inc.length - 1) == str.char) {
        end -= 1;
      }
      inc = inc.substring(1, end);
    }
    return inc;
  }

  private readState(va: string): string | DefFunc | null {
    switch (va) {
      case "__FILE__":
        return `"${this.relative}"`;
      case "__COMMENT__SINGLE__":
        return this.single;
      case "__LINE__":
        return (this.iter.trueLine + 1).toString();
      case "__SHORT_FILE__":
        return `"${this.relative.split("/").pop()}"`;
      case "__DEPTH__":
        return (this.fileDepth - 1).toString();
      default:
        return this.state.read(va);
    }
  }

  private error(err: string) {
    //console.trace();
    throw `PreProc Error: ${this.file} [${this.iter.line + 1}]: ${err}`;
  }

  private getLineCmd(line: string): [string, string] | false {
    if (line.indexOf(this.lead) !== 0) return false;
    line = line.substring(this.lead.length);
    let idx = line.indexOf(" ");
    if (idx < 0) idx = line.length;
    return [
      line.substring(0, idx),
      this.readLineEndsWithEscape(line.substring(idx).trim()),
    ];
  }

  private get lead(): string {
    if (this.language.leadCharCommented) {
      return `${this.language.comments.single}${this.language.leadChar}`;
    } else {
      return this.language.leadChar;
    }
  }

  private readLinesTillOutOfIf() {
    const start = this.iter.line;
    let depth = 1;

    out: {
      while (this.iter.peekValid()) {
        const line = this.iter.next() as string;
        // console.log("Skipping", this.iter.line + 1, line);
        const res = this.getLineCmd(line);
        if (!res) continue;
        const [cmd, _arg] = res;
        switch (cmd) {
          case "if":
          case "ifdef":
          case "ifndef":
            depth++;
            break;
          case "else":
            if (depth == 0) break out;
            break;
          case "endif":
            depth--;
            if (depth == 0) {
              this.ifDepth--;
              break out;
            }
            break;
        }
      }
    }
    if (depth > 0) {
      this.error(`Hit end of file while in #if from [${start}]`);
    }
    // console.log("Exiting Skip");
  }

  private get single(): string {
    return this.language.comments.single;
  }
  private get char(): string {
    return this.language.leadChar;
  }
}

type IfStack = [boolean, number];

export interface PreProcStateInterface {
  store: (name: string, value: string) => void;
  read: (name: string) => string | DefFunc | null;
  defines: string[];
  addFile: (path: string) => void;
  files: string[];
}

export type DefFunc = (args: string[]) => string;

export type LangStringDef = {
  char: string;
  escape: string;
  interpolate?: {
    start: string;
    end: string;
  };
};

export type LangStringDefs = LangStringDef[];

export type PreProcConfig = {
  root: string;
  language: LanguageConfig;
  options: { [k: string]: string | boolean };
};

export type LanguageConfig = {
  comments: {
    single: string;
    multi: {
      open: string;
      close: string;
    } | false;
  };
  string: LangStringDefs;
  leadChar: string;
  leadCharCommented: boolean;
  validSymbol: RegExp;
  predefined?: { [k: string]: string };
};
