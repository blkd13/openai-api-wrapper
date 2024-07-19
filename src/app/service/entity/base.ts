import { BaseEntity, UpdateDateColumn, CreateDateColumn, Column, BeforeInsert, BeforeUpdate } from 'typeorm';
// sqlite3の場合、timestamp型はサポートされていないので、text型で代用する
// const timestamp = 'datetime' || 'timestamp';
const timestamp = 'timestamp';

export class MyBaseEntity extends BaseEntity {
    @Column({ nullable: false })
    createdBy!: string;

    @Column({ nullable: false })
    updatedBy!: string;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt!: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt!: Date;

    // @BeforeInsert()
    // setCreatedAt() {
    //     this.createdAt = new Date();
    //     this.updatedAt = new Date();
    // }

    // @BeforeUpdate()
    // setUpdatedAt() {
    //     this.updatedAt = new Date();
    // }
}