declare module 'synaptic' {
  namespace Architect {
    class Perceptron {
      constructor(...layers: number[]);
      activate(input: number[]): number[];
    }
    class LSTM {
      constructor(input: number, ...layers: number[]);
      activate(input: number[]): number[];
    }
  }

  class Trainer {
    constructor(network: Architect.Perceptron | Architect.LSTM);
    train(
      data: Array<{ input: number[]; output: number[] }>,
      options?: {
        rate?: number;
        iterations?: number;
        error?: number;
        shuffle?: boolean;
        log?: number;
        cost?: unknown;
      }
    ): { error: number; iterations: number; time: number };
  }

  const synaptic: {
    Architect: typeof Architect;
    Trainer: typeof Trainer;
  };

  export default synaptic;
  export { Architect, Trainer };
}
