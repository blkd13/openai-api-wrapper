import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { MyBaseEntity } from './base.js';


@Entity()
export class UserEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    name?: string;

    @Column()
    email!: string;

    @Column({ nullable: true })
    passwordHash?: string;

    @Column({ nullable: true })
    authGeneration?: number;
}


@Entity()
export class InviteEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    email!: string;

    @Column()
    type!: string;

    @Column()
    onetimeToken!: string;

    @Column()
    data!: string;

    @Column()
    status!: string;

    @Column({ type: 'bigint' })
    limit!: number;
}
