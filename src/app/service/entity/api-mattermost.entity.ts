import { Entity, Column, PrimaryColumn, Index, PrimaryGeneratedColumn, In } from 'typeorm';
import { MyBaseEntity } from './base.js';

@Entity() // テーブル名を指定
// @Index(['orgKey', 'id'], { unique: true }) // インデックスを追加
@Index(['orgKey', 'username'], { unique: true }) // インデックスを追加
export class MmUserEntity {
    @PrimaryColumn()
    orgKey!: string; // テナントキーを追加

    @Column()
    seq!: number;

    @PrimaryColumn()
    id!: string;

    @Column({ type: 'timestamptz' })
    create_at!: Date;

    @Column({ type: 'timestamptz' })
    update_at!: Date;

    @Column({ type: 'timestamptz', nullable: true })
    delete_at?: Date;

    @Column()
    username!: string;

    @Column({ nullable: true })
    auth_data?: string;

    @Column({ nullable: true })
    auth_service?: string;

    @Column()
    email!: string;

    @Column()
    nickname!: string;

    @Column()
    first_name!: string;

    @Column()
    last_name!: string;

    @Column({ nullable: true })
    position?: string;

    @Column()
    roles!: string;

    @Column()
    locale!: string;

    @Column('jsonb') // JSON形式で保存する場合
    timezone!: {
        automaticTimezone: string;
        manualTimezone: string;
        useAutomaticTimezone: boolean;
    };

    @Column()
    disable_welcome_email!: boolean;
}

@Entity()
export class MmUserPreEntity extends MmUserEntity { }

// @Entity() // テーブル名を適宜変更してください
// export class MmTeamEntity {
//     @PrimaryColumn()
//     id!: string;

//     @Column({ type: 'timestamptz' })
//     create_at!: Date;

//     @Column({ type: 'timestamptz' })
//     update_at!: Date;

//     @Column({ type: 'timestamptz', nullable: true })
//     delete_at?: Date;

//     @Column()
//     display_name!: string;

//     @Column()
//     @Index({ unique: true })
//     name!: string;

//     @Column({ nullable: true })
//     description?: string;

//     @Column({ nullable: true })
//     email?: string;

//     @Column()
//     type!: string;

//     @Column({ nullable: true })
//     company_name?: string;

//     @Column({ nullable: true })
//     allowed_domains?: string;

//     @Column({ nullable: true })
//     invite_id?: string;

//     @Column()
//     allow_open_invite!: boolean;

//     @Column({ type: 'timestamptz' })
//     last_team_icon_update!: Date;

//     @Column({ nullable: true }) // nullを許容
//     scheme_id?: string;

//     @Column({ nullable: true })
//     group_constrained?: boolean;

//     @Column({ nullable: true })
//     policy_id?: string;

//     @Column()
//     cloud_limits_archived!: boolean;
// }


// @Entity()
// export class MmEmojiEntity {
//     @PrimaryColumn()
//     id!: string;

//     @Column({ type: 'timestamptz' })
//     create_at!: Date;

//     @Column({ type: 'timestamptz' })
//     update_at!: Date;

//     @Column({ type: 'timestamptz', nullable: true })
//     delete_at?: Date;

//     @Column()
//     creator_id!: string;

//     @Column()
//     @Index({ unique: true })
//     name!: string;
// }

@Entity()
@Index(['orgKey', 'id'], { unique: true }) // インデックスを追加
export class MmPostEntity {
    @PrimaryColumn()
    orgKey!: string; // テナントキーを追加

    @PrimaryColumn()
    id!: string;

    @Column({ type: 'timestamptz' })
    create_at!: Date;

    @Column({ type: 'timestamptz' })
    update_at!: Date;

    @Column({ type: 'timestamptz' })
    edit_at?: Date;

    @Column({ type: 'timestamptz', nullable: true })
    delete_at?: Date;

    @Column()
    is_pinned!: boolean;

    @Column()
    user_id!: string;

    @Column()
    channel_id!: string;

    @Column({ nullable: true })
    root_id?: string;

    @Column({ nullable: true })
    original_id?: string;

    @Column()
    message!: string;

    @Column({ nullable: true })
    type!: string;

    @Column('jsonb')
    props!: { disable_group_highlight?: boolean };

    @Column({ nullable: true })
    hashtags?: string;

    @Column({ nullable: true })
    pending_post_id?: string;

    @Column()
    reply_count!: number;

    @Column({ nullable: true })
    last_reply_at?: Date;

    @Column('jsonb', { nullable: true })
    participants: any;

    @Column('jsonb', { nullable: true })
    metadata?: {
        embeds?: Array<{
            type: string;
            url: string;
            data?: {
                type: string;
                url: string;
                title: string;
                description: string;
                determiner: string;
                site_name: string;
                locale: string;
                locales_alternate: any;
                images: Array<{
                    url: string;
                    secure_url: string;
                    type: string;
                    width: number;
                    height: number;
                }>;
                audios: any;
                videos: any;
            };
        }>,
        images?: {
            [key: string]: {
                width: number;
                height: number;
                format: string;
                frame_count: number;
            };
        },
        emoji?: {
            id: string,
            create_at: Date,
            update_at: Date,
            delete_at?: Date,
            creator_id: string,
            name: string,
        }[],
        files?: {
            id: string,
            user_id: string,
            post_id: string,
            channel_id?: string,
            create_at: Date,
            update_at: Date,
            delete_at?: Date,
            name: string,
            extension?: string,
            size: number,
            mime_type: string,
            mini_preview?: string,
            remote_id?: string,
            archived: boolean,
        }[],
        reactions?: {
            user_id: string,
            post_id: string,
            emoji_name: string,
            create_at: Date,
            update_at: Date,
            delete_at?: Date,
            remote_id?: string,
            channel_id?: string,
        }[],
    };
}

export enum MmTimelineStatus {
    Normal = 'Normal', // 普通
    Deleted = 'Deleted', // 削除済み
}

@Entity()
@Index(['orgKey', 'userId']) // インデックスを追加
export class MmTimelineEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column({ type: 'uuid' })
    userId!: string;

    @Column()
    title!: string;

    @Column({ nullable: true, type: 'text' })
    description?: string;

    @Column({ type: 'enum', enum: MmTimelineStatus, default: MmTimelineStatus.Normal })
    status!: MmTimelineStatus;

    @Column({ type: 'int', default: 0 })
    sortOrder!: number;
}

@Entity()
@Index(['orgKey', 'timelineId']) // インデックスを追加
export class MmTimelineChannelEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column({ type: 'uuid' })
    timelineId!: string;

    @Column()
    channelId!: string;

    @Column({ default: false })
    isMute!: boolean;

    @Column({ type: 'timestamptz', nullable: true })
    lastViewedAt?: Date;

    @Column({ type: 'int', default: 0 })
    sortOrder!: number;
}

// ユーザーグループ スコープ
export enum MmUserGroupScope {
    Personal = 'personal', // 作成者本人のみ使用可能
    Team = 'team', // チーム内の全員が使用可能
}

// ユーザーグループ ステータス
export enum MmUserGroupStatus {
    Normal = 'Normal', // 普通
    Deleted = 'Deleted', // 削除済み
}

@Entity()
@Index(['orgKey', 'ownerId']) // インデックスを追加
@Index(['orgKey', 'mmTeamId']) // インデックスを追加
@Index(['orgKey', 'ownerId', 'handle'], { unique: true, where: `"scope" = 'personal' AND "status" = 'Normal'` }) // personalスコープ内でのハンドル一意性
@Index(['orgKey', 'mmTeamId', 'handle'], { unique: true, where: `"scope" = 'team' AND "status" = 'Normal'` }) // teamスコープ内でのハンドル一意性
export class MmUserGroupEntity extends MyBaseEntity {
    @Column({ length: 64 })
    name!: string;

    @Column({ length: 32 })
    handle!: string;

    @Column('text', { array: true })
    memberIds!: string[];

    @Column({ type: 'uuid' })
    ownerId!: string;

    @Column({ type: 'enum', enum: MmUserGroupScope })
    scope!: MmUserGroupScope;

    @Column({ nullable: true })
    mmTeamId?: string; // MattermostのチームID（scope='team'の場合は必須）

    @Column({ type: 'enum', enum: MmUserGroupStatus, default: MmUserGroupStatus.Normal })
    status!: MmUserGroupStatus;
}


// @Entity()
// export class MmFileEntity extends MyBaseEntity {
//     // @PrimaryGeneratedColumn('uuid')
//     // id!: string;

//     @Column()
//     domain!: string;

//     @Column()
//     mmFiileId!: string;

//     @Column()
//     fileBodyId!: string;
// }
