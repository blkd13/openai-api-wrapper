import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { MyBaseEntity } from "./base.js";

@Entity()
export class VertexCachedContentEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column()
    modelAlias!: string;
    @Column()
    location!: string;

    @Column()
    projectId!: string;
    @Column({ nullable: true })
    title?: string;
    @Column({ nullable: true })
    description?: string;

    @Column()
    name!: string;
    @Column()
    model!: string;
    @Column({ type: 'timestamptz' })
    createTime!: Date;
    @Column({ type: 'timestamptz' })
    updateTime!: Date;
    @Column({ type: 'timestamptz' })
    expireTime!: Date;

    // @Column()
    // promptTokenCount!: number;
    // @Column()
    // candidatesTokenCount!: number;
    // @Column()
    // totalTokenCount!: number;

    @Column({ nullable: true })
    totalBillableCharacters?: number;
    @Column()
    totalTokens!: number;

    @Column()
    audio!: number;
    @Column()
    image!: number;
    @Column()
    text!: number;
    @Column()
    video!: number;

    @Column()
    usage!: number;
}
