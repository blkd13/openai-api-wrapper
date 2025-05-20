import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { MyBaseEntity } from "./base.js";

@Entity()
@Index(['orgKey', 'name'])
export class VertexCachedContentEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column()
    modelAlias!: string;
    @Column()
    location!: string;

    @Column({ type: 'uuid' })
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

    @Column({ type: 'numeric' })
    audio!: number;
    @Column({ type: 'numeric' })
    image!: number;
    @Column()
    text!: number;
    @Column({ type: 'numeric' })
    video!: number;

    @Column()
    usage!: number;
}
