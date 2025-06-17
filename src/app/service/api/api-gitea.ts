import { Request, Response } from 'express';
import { param, body } from 'express-validator';

import { ds } from '../db.js';
import { OAuthUserRequest } from '../models/info.js';
import { ProjectEntity, TeamMemberEntity } from '../entity/project-models.entity.js';
import { FileGroupType, ProjectVisibility } from '../models/values.js';
import { ExtApiClient, getExtApiClient } from '../controllers/auth.js';
import { GitProjectCommitEntity } from '../entity/api-git.entity.js';
import { FileGroupEntity } from '../entity/file-models.entity.js';
import { copyFromFirst, gitFetchCommitId } from './git-core.js';
import { getAxios } from '../../common/http-client.js';

export const fetchCommit = [
    param('providerName').isString().notEmpty(),
    param('owner').isString().notEmpty(),
    param('repo').isString().notEmpty(),
    param('refType').isIn(['branches', 'tags', 'commits']).optional(),
    // refId は route 定義で `:owner/:repo/:refType/*` のようになっている想定で、後ろをまとめて取得する
    body('projectId').isString().notEmpty(),
    async (_req: Request, res: Response) => {
        try {
            const req = _req as OAuthUserRequest;
            const { providerName, owner, repo, refType } = req.params as {
                providerName: string;
                owner: string;
                repo: string;
                refType?: 'branches' | 'tags' | 'commits';
            };
            const { projectId } = req.body as { projectId: string; };
            const provider = `gitea-${providerName}`;

            // refId は省略可能なので route 定義上 [0] に入る部分を取り出す想定
            const refId = req.params[0] as string | undefined;

            // プロジェクトの存在確認
            const project = await ds.getRepository(ProjectEntity).findOne({ where: { orgKey: req.info.user.orgKey, id: projectId } });
            if (!project) {
                res.status(404).json({ error: '指定されたプロジェクトが見つかりません' });
                return;
            }

            // 権限チェック (Public / Login 以外はチームメンバーである必要がある)
            const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                where: { orgKey: req.info.user.orgKey, userId: req.info.user.id, teamId: project.teamId },
            });
            if (project.visibility !== ProjectVisibility.Public && project.visibility !== ProjectVisibility.Login && !teamMember) {
                res.status(403).json({ error: 'このプロジェクトにファイルをアップロードする権限がありません' });
                return;
            }

            // OAuth2設定読み込み
            const e = {} as ExtApiClient;
            try {
                Object.assign(e, await getExtApiClient(req.info.user.orgKey, provider));
            } catch (error) {
                res.status(401).json({ error: `${provider}は認証されていません。` });
                return;
            }
            const _axios = await getAxios(e.uriBase);

            // Gitea baseUrl およびアクセストークン
            const baseUrl = e.uriBase;
            const accessToken = req.info.oAuth.accessToken;

            // リポジトリ情報取得 (リポジトリIDなどを取得して参照権限チェックの想定)
            const repoRes = await _axios.get<GiteaRepository>(`${baseUrl}/api/v1/repos/${owner}/${repo}`, { headers: { Authorization: `token ${accessToken}` } });
            const repository = repoRes.data;
            // console.log('Repository:', repository);

            // refType から commitId を特定
            let commitId: string;
            switch (refType) {
                case 'branches': {
                    const branch = await _axios.get<GiteaBranch>(`${baseUrl}/api/v1/repos/${owner}/${repo}/branches/${encodeURIComponent(refId || '')}`, { headers: { Authorization: `token ${accessToken}` } });
                    commitId = branch.data.commit.id;
                    break;
                }
                case 'tags': {
                    const tag = await _axios.get<GiteaTag>(`${baseUrl}/api/v1/repos/${owner}/${repo}/tags/${encodeURIComponent(refId || '')}`, { headers: { Authorization: `token ${accessToken}` } });
                    commitId = tag.data.commit.sha;
                    break;
                }
                case 'commits': {
                    const commit = await _axios.get<GiteaCommit>(`${baseUrl}/api/v1/repos/${owner}/${repo}/git/commits/${refId}`, { headers: { Authorization: `token ${accessToken}` } });
                    commitId = commit.data.sha;
                    break;
                }
                default: {
                    // refType 未指定ならデフォルトブランチ
                    const defaultBranch = await _axios.get<GiteaBranch>(`${baseUrl}/api/v1/repos/${owner}/${repo}/branches/${encodeURIComponent(repository.default_branch || 'master')}`, { headers: { Authorization: `token ${accessToken}` } });
                    commitId = defaultBranch.data.commit.id;
                    break;
                }
            }

            // 既に同じ commitId をダウンロード済みかどうかチェック
            let gitProjectCommit = await ds.getRepository(GitProjectCommitEntity).findOne({
                where: { orgKey: req.info.user.orgKey, provider, gitProjectId: repository.id, commitId },
            });

            let fileGroup: FileGroupEntity | undefined = undefined;

            if (gitProjectCommit) {
                // 既に同じコミットをダウンロード済みの場合
                fileGroup = await copyFromFirst(gitProjectCommit.fileGroupId, project, req.info.user.orgKey, req.info.user.id, req.info.ip);
            } else {
                // まだダウンロードしていない場合はアーカイブなどから取得してアップロードする
                const descriptionObject = { provider, owner, repo, refType, refId, commitId };
                const http_url_to_repo = repository.html_url;
                const path_with_namespace = repository.full_name;
                const object = await gitFetchCommitId(req.info.user.orgKey, req.info.user.id, req.info.ip, projectId, FileGroupType.GITEA, repository.name, provider, descriptionObject, repository.id, e.uriBase, http_url_to_repo, path_with_namespace, encodeURIComponent(req.info.oAuth.providerEmail || ''), accessToken, commitId, req.info.user);
                gitProjectCommit = object.gitProjectCommit;
                fileGroup = object.fileGroup;
            }

            // 最後に結果を返す
            return res.json({ gitProjectCommit, fileGroup });
        } catch (err) {
            console.error(err);
            if (err instanceof Error) {
                try {
                    const obj = JSON.parse(err.message);
                    res.status(obj.status || 500).json(obj);
                } catch (error) {
                    res.status(500).json({ error: 'Failed to download all files' });
                }
            } else {
                res.status(500).json({ error: 'Failed to download all files' });
            }
        }
    },
];

//
// リポジトリ情報取得 (GET /api/v1/repos/{owner}/{repo}) で返ってくるデータ
//
export interface GiteaRepository {
    id: number;
    name: string;
    full_name: string;
    // 省略可能なプロパティは ? を付ける
    private?: boolean;
    fork?: boolean;
    default_branch?: string;
    html_url: string;
    // 必要に応じて他のフィールドを追加
    [key: string]: any; // 予期しないフィールドを受け取った場合もエラーにならないように
}

//
// ブランチ情報取得 (GET /api/v1/repos/{owner}/{repo}/branches/{branch}) などで返ってくるデータ
//
// 注意:
//  - Gitea の一部エンドポイントでは commit オブジェクトが { id: string; ... } の形
//  - 別のエンドポイントでは { sha: string; ... } の形になる場合もあります
//  - コード内で branch.data.commit.id を参照しているので、ここでは id: string を使う例を示します
//
export interface GiteaBranch {
    name: string;
    commit: {
        id: string;           // GitLab でいう commit.id に相当するもの
        message?: string;
        url?: string;
        author?: {
            name: string;
            email: string;
            date?: string;
            [key: string]: any;
        };
        committer?: {
            name: string;
            email: string;
            date?: string;
            [key: string]: any;
        };
        [key: string]: any;
    };
    protected: boolean;
    [key: string]: any;
}

//
// タグ情報取得 (GET /api/v1/repos/{owner}/{repo}/tags/{tag}) で返ってくるデータ
//
// コード内で tag.data.commit.sha を参照しているので、commit フィールドは { sha: string } を想定
//
export interface GiteaTag {
    name: string;
    commit: {
        sha: string;          // tag では sha というフィールド名
        message?: string;
        url?: string;
        [key: string]: any;
    };
    tarball_url?: string;
    zipball_url?: string;
    [key: string]: any;
}

//
// コミット情報取得 (GET /api/v1/repos/{owner}/{repo}/git/commits/{sha}) で返ってくるデータ
//
// Gitea 上では "GitCommit" という名前で返されるケースが多いですが、ここでは GiteaCommit として定義
// コード内で commit.data.sha を参照しているので、sha フィールドを持たせる
//
export interface GiteaCommit {
    sha: string;           // commit SHA
    message?: string;
    author?: {
        name: string;
        email: string;
        date?: string;
        [key: string]: any;
    };
    committer?: {
        name: string;
        email: string;
        date?: string;
        [key: string]: any;
    };
    parents?: Array<{
        sha: string;
        url?: string;
        html_url?: string;
    }>;
    html_url?: string;
    url?: string;
    [key: string]: any;
}
