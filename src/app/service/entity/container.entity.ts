import { Entity, PrimaryGeneratedColumn, Column, Index, Generated } from 'typeorm';
import { MyBaseEntity } from './base.js';

// コンテナの状態を定義
export enum ContainerStatus {
    CREATED = 'created',
    RUNNING = 'running',
    PAUSED = 'paused',
    RESTARTING = 'restarting',
    REMOVING = 'removing',
    EXITED = 'exited',
    DEAD = 'dead',
}

@Entity()
export class ContainerInstanceEntity extends MyBaseEntity {
    @Column({ type: 'uuid' })
    projectId!: string;

    @Column({ type: 'integer' })
    @Generated('increment')
    seq!: number;

    @Column('integer', { array: true })
    ports!: number[];

    @Column({ type: 'enum', enum: ContainerStatus, default: ContainerStatus.CREATED })
    status!: ContainerStatus;
}
