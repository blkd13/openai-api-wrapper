import { Entity, Column, Index } from 'typeorm';
import { MyBaseEntity } from './base.js';

@Entity()
@Index(['orgKey', 'userId']) // 複合インデックス
@Index(['orgKey', 'userId', 'key'], { unique: true }) // 複合インデックス
export class UserSettingEntity extends MyBaseEntity {

    @Column({ type: 'uuid' })
    userId!: string;

    @Column()
    key!: string;

    // @Column({ type: 'text' })
    // value!: string;
    @Column({ type: 'jsonb' })
    value!: any; // JSON型を保存
}
