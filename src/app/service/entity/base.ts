import { BaseEntity, UpdateDateColumn, CreateDateColumn } from 'typeorm';
// sqlite3の場合、timestamp型はサポートされていないので、text型で代用する
const timestamp = 'timestamp';
// const timestamp = 'datetime' || 'timestamp';

export class MyBaseEntity extends BaseEntity {
    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
