export interface Pos { line: number; character: number }
export interface Range { start: Pos; end: Pos }

export class LineIndex {
  private readonly starts: number[] = [0];
  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  pos(offset: number): Pos {
    let lo = 0, hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo, character: offset - this.starts[lo] };
  }
  range(start: number, end: number): Range { return { start: this.pos(start), end: this.pos(end) }; }
}
