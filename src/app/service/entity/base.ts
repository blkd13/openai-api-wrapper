import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, ManyToMany, JoinTable, OneToOne, JoinColumn, BaseEntity, UpdateDateColumn } from 'typeorm';
// sqlite3の場合、timestamp型はサポートされていないので、text型で代用する
const timestamp = 'datetime' || 'timestamp';

export class MyBaseEntity extends BaseEntity {
    @Column({ type: timestamp, default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;

    // @Column({ type: timestamp, default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
    @UpdateDateColumn()
    updatedAt!: Date;
}
