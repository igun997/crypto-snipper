declare module 'asciichart' {
  interface PlotOptions {
    offset?: number;
    padding?: string;
    height?: number;
    format?: (x: number) => string;
    colors?: number[];
  }

  export function plot(series: number[] | number[][], options?: PlotOptions): string;

  // Color codes
  export const black: number;
  export const red: number;
  export const green: number;
  export const yellow: number;
  export const blue: number;
  export const magenta: number;
  export const cyan: number;
  export const lightgray: number;
  export const default_: number;
  export const darkgray: number;
  export const lightred: number;
  export const lightgreen: number;
  export const lightyellow: number;
  export const lightblue: number;
  export const lightmagenta: number;
  export const lightcyan: number;
  export const white: number;
}
