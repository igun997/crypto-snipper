import { getDatabase } from '../connection.js';
import { Prediction, AccuracyResult, AccuracySummary, FormulaType } from '../../types/index.js';

export class PredictionRepository {
  insertPrediction(prediction: Prediction): number {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO predictions (symbol, formula_type, predicted_price, predicted_direction, confidence, interval_minutes, timestamp, target_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      prediction.symbol,
      prediction.formula_type,
      prediction.predicted_price,
      prediction.predicted_direction,
      prediction.confidence,
      prediction.interval_minutes,
      prediction.timestamp,
      prediction.target_timestamp
    );
    return result.lastInsertRowid as number;
  }

  getPendingEvaluations(): Prediction[] {
    const db = getDatabase();
    const now = Date.now();
    const stmt = db.prepare(`
      SELECT p.* FROM predictions p
      LEFT JOIN accuracy_results ar ON p.id = ar.prediction_id
      WHERE ar.id IS NULL AND p.target_timestamp <= ?
      ORDER BY p.target_timestamp ASC
    `);
    return stmt.all(now) as Prediction[];
  }

  getRecentPredictions(symbol: string, limit: number = 50): Prediction[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM predictions
      WHERE symbol = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(symbol, limit) as Prediction[];
  }

  getPredictionById(id: number): Prediction | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM predictions WHERE id = ?');
    return (stmt.get(id) as Prediction) || null;
  }

  insertAccuracyResult(result: AccuracyResult): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO accuracy_results (prediction_id, actual_price, actual_direction, mape, is_direction_correct)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      result.prediction_id,
      result.actual_price,
      result.actual_direction,
      result.mape,
      result.is_direction_correct
    );
  }

  getAccuracyResults(symbol?: string, formulaType?: FormulaType): AccuracyResult[] {
    const db = getDatabase();
    let sql = `
      SELECT ar.* FROM accuracy_results ar
      JOIN predictions p ON ar.prediction_id = p.id
      WHERE 1=1
    `;
    const params: (string | undefined)[] = [];

    if (symbol) {
      sql += ' AND p.symbol = ?';
      params.push(symbol);
    }
    if (formulaType) {
      sql += ' AND p.formula_type = ?';
      params.push(formulaType);
    }

    sql += ' ORDER BY ar.evaluated_at DESC';

    const stmt = db.prepare(sql);
    return stmt.all(...params) as AccuracyResult[];
  }

  getAccuracySummary(symbol?: string, formulaType?: FormulaType): AccuracySummary[] {
    const db = getDatabase();
    let sql = `
      SELECT
        p.symbol,
        p.formula_type,
        COUNT(ar.id) as total_predictions,
        SUM(ar.is_direction_correct) as correct_directions,
        AVG(ar.mape) as avg_mape,
        MIN(ar.evaluated_at) as period_start,
        MAX(ar.evaluated_at) as period_end
      FROM accuracy_results ar
      JOIN predictions p ON ar.prediction_id = p.id
      WHERE 1=1
    `;
    const params: (string | undefined)[] = [];

    if (symbol) {
      sql += ' AND p.symbol = ?';
      params.push(symbol);
    }
    if (formulaType) {
      sql += ' AND p.formula_type = ?';
      params.push(formulaType);
    }

    sql += ' GROUP BY p.symbol, p.formula_type ORDER BY p.symbol, p.formula_type';

    const stmt = db.prepare(sql);
    return stmt.all(...params) as AccuracySummary[];
  }

  getComparisonStats(): { formula_type: FormulaType; total: number; correct: number; avg_mape: number }[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT
        p.formula_type,
        COUNT(ar.id) as total,
        SUM(ar.is_direction_correct) as correct,
        AVG(ar.mape) as avg_mape
      FROM accuracy_results ar
      JOIN predictions p ON ar.prediction_id = p.id
      GROUP BY p.formula_type
    `);
    return stmt.all() as { formula_type: FormulaType; total: number; correct: number; avg_mape: number }[];
  }
}

export default new PredictionRepository();
