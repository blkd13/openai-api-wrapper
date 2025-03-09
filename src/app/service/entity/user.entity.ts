import { Entity, Column, Index } from 'typeorm';
import { MyBaseEntity } from './base.js';

@Entity()
@Index(['userId', 'key'], { unique: true }) // 複合インデックス
export class UserSettingEntity extends MyBaseEntity {

    @Index() // インデックス
    @Column()
    userId!: string;

    @Column()
    key!: string;

    // @Column({ type: 'text' })
    // value!: string;
    @Column({ type: 'jsonb' })
    value!: any; // JSON型を保存
}
