import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, ManyToMany, JoinTable, OneToOne, JoinColumn, BaseEntity } from 'typeorm';
import { MyBaseEntity } from './base.js';
import { UserEntity } from './auth.entity.js';
import { DevelopmentStageType, DocumentSubType, DocumentType, ProjectStatus } from '../models/values.js';

@Entity()
export class ProjectEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    name!: string;

    @Column()
    label!: string;

    @Column()
    description?: string;

    @Column()
    status!: ProjectStatus;

    @OneToMany(() => DevelopmentStageEntity, stage => stage.project)
    stages!: DevelopmentStageEntity[];
}

@Entity()
export class DevelopmentStageEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    type!: DevelopmentStageType;

    @Column()
    name!: string;

    @Column()
    status!: ProjectStatus;

    @ManyToOne(() => ProjectEntity, project => project.stages)
    project!: ProjectEntity;

    @OneToMany(() => TaskEntity, task => task.stage)
    tasks!: TaskEntity[];

    // @OneToMany(() => DocumentEntity)
    // @JoinTable()
    // documents!: DocumentEntity[];

    // @OneToMany(() => DiscussionEntity)
    // @JoinTable()
    // discussions!: DiscussionEntity[];
}

@Entity()
export class TaskEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    name!: string;

    @ManyToMany(() => DocumentEntity)
    @JoinTable()
    documents!: DocumentEntity[];

    @ManyToMany(() => DiscussionEntity)
    @JoinTable()
    discussions!: DiscussionEntity[];

    @Column()
    status!: ProjectStatus;

    @ManyToOne(() => DevelopmentStageEntity, stage => stage.tasks)
    stage!: DevelopmentStageEntity;
}

@Entity()
export class DocumentEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    type!: DocumentType;

    @Column()
    subType!: DocumentSubType;

    @Column()
    title!: string;

    @Column({ type: 'text' })
    content!: string;

    @Column()
    status!: ProjectStatus;
}

@Entity()
export class DiscussionEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    topic!: string;

    @Column()
    logLabel!: string;

    @OneToMany(() => StatementEntity, statement => statement.discussion)
    statements!: StatementEntity[];

    @ManyToMany(() => UserEntity)
    @JoinTable()
    participants!: UserEntity[];
}

@Entity()
export class StatementEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    sequence!: number;

    @Column()
    speaker!: string;

    @Column({ type: 'text' })
    content!: string;

    @ManyToOne(() => DiscussionEntity, discussion => discussion.statements)
    discussion!: DiscussionEntity;
}
