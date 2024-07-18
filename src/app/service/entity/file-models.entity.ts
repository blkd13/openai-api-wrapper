import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';
import { MyBaseEntity } from './base.js';

@Entity()
export class FileEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column()
    fileName!: string;

    @Column()
    filePath!: string;

    @Column({ nullable: true })
    description?: string;

    @Column()
    projectId!: string;

    @Column()
    uploadedBy!: string;

    @Column()
    fileBodyId!: string;
}

@Entity()
export class FileBodyEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column()
    fileType!: string;

    @Column()
    fileSize!: number;

    @Column()
    innerPath!: string;

    @Column({ unique: true }) // ユニーク制約を付ける
    sha256!: string;

    @Column({ nullable: true })
    metaJson?: string;
}

@Entity()
export class FileTagEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column()
    name!: string;

    @Column()
    fileId!: string;
}

@Entity()
export class FileVersionEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column()
    fileId!: string;

    @Column()
    versionNumber!: number;

    @Column()
    filePath!: string;

    @Column()
    uploadedBy!: string;
}

@Entity()
export class FileAccessEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column()
    fileId!: string;

    @Column()
    teamId!: string;

    @Column()
    canRead!: boolean;

    @Column()
    canWrite!: boolean;

    @Column()
    canDelete!: boolean;
}