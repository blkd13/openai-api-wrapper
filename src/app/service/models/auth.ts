import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { MyBaseEntity } from './common.js';


@Entity()
export class UserEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    name!: string;

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

    @Column()
    limit!: number;
}


// import { Model, DataTypes } from 'sequelize';
// import sequelize from '../db.js';

// export interface UserDto {
//     id: number;
//     name: string;
//     email: string;
// }

// class _UserModel extends Model { }
// _UserModel.init({
//     id: {
//         type: DataTypes.INTEGER,
//         autoIncrement: true,
//         primaryKey: true
//     },
//     name: DataTypes.STRING,
//     email: DataTypes.STRING,
//     passwordHash: DataTypes.STRING,
//     authGeneration: DataTypes.NUMBER,
//     createdAt: DataTypes.DATE,
//     updatedAt: DataTypes.DATE,
// }, { sequelize, modelName: 'users' });

// // 一応DIっぽくする
// export class UserModel extends _UserModel { }

// // ------------------------------

// export interface InviteDto {
//     id: number;
//     email: string;
// }

// class _InviteModel extends Model { }
// _InviteModel.init({
//     id: {
//         type: DataTypes.INTEGER,
//         autoIncrement: true,
//         primaryKey: true
//     },
//     // name: DataTypes.STRING,
//     email: DataTypes.STRING,
//     type: DataTypes.STRING,
//     onetimeToken: DataTypes.STRING,
//     data: DataTypes.STRING,
//     status: DataTypes.STRING,
//     limit: DataTypes.NUMBER,
//     createdAt: DataTypes.DATE,
//     updatedAt: DataTypes.DATE,
// }, { sequelize, modelName: 'invites' });

// // 一応DIっぽくする
// export class InviteModel extends _InviteModel { }

