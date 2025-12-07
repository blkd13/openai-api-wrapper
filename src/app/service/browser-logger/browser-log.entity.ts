import { BaseEntity, Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { MyBaseEntity } from '../entity/base.js';

// content.js -> background.js に送られる単一ログ
export interface LogEntry {
  url: string;             // 対象ページURL
  start: number;           // interval開始時刻 (ms epoch)
  end: number;             // interval終了時刻 (ms epoch)
  active: boolean;         // アクティブ状態
  keyCount: number;        // キーボード入力の回数
  mouseEvents: number;     // マウスイベント総数
}

// background.js → サーバー に送る一日分のデータ
export interface DailyLogPayload {
  uniqueId: string;          // 協力者ID
  date: string;            // "YYYY-MM-DD"
  entries: LogEntry[];     // その日の全エントリ
}

@Entity()
export class BrowserDailyLogEntity extends MyBaseEntity {
  @Column()
  uniqueId!: string;

  @Column()
  date!: string;

  @Column({ type: 'jsonb' })
  entries!: LogEntry[];
}
