import * as fs from 'fs';
import path from 'path';
import simpleGit, { SimpleGit } from 'simple-git';
import { PassThrough } from 'stream';
import tar from 'tar-stream';
import { In } from 'typeorm';

import { getProxyUrl } from '../../common/http-client.js';
import { getExtApiClient } from '../controllers/auth.js';
import { uploadFileFunction } from '../controllers/file-manager.js';
import { ds } from '../db.js';
import { GitProjectCommitEntity, GitProjectEntity, GitProjectStatus } from '../entity/api-git.entity.js';
import { FileAccessEntity, FileEntity, FileGroupEntity } from '../entity/file-models.entity.js';
import { ProjectEntity } from '../entity/project-models.entity.js';
import { UserTokenPayloadWithRole } from '../middleware/authenticate.js';
import { FileGroupType } from '../models/values.js';

const { GIT_REPOSITORIES } = process.env as { GIT_REPOSITORIES: string };

/**
 * 指定されたリファレンス（commit ID）が存在するかチェックする関数
 * @param repoDir リポジトリのディレクトリ
 * @param ref チェックするcommit ID
 * @returns リファレンスが存在すればtrue、存在しなければfalse
 */
async function isRefExist(repoDir: string, ref: string): Promise<boolean> {
    const git: SimpleGit = simpleGit();
    try {
        console.log(`Current working directory: ${await git.revparse(['--show-toplevel'])}`); // 現在のGitルートディレクトリを出力
        // `git cat-file -e <ref>` はリファレンスが存在する場合はエラーを返しません
        const revparse = await git.cwd(repoDir).revparse(['--verify', ref]);
        const cat = await git.cwd(repoDir).raw(['cat-file', '-e', ref]);
        // console.log(`revparse: ${revparse}`);
        // console.log(`cat: ${cat}`);
        return !!cat; // この判定でいいのかは自信ない。。。
        return true;
    } catch (err) {
        console.error(`Error checking ref ${ref} in ${repoDir}:`, err);
        if ((err as Error).message.includes('fatal')) {
            return false; // リファレンスが存在しない
        }
        throw err; // 予期しないエラーの場合は再スロー
    }
}

interface FileContent { name: string; content: Buffer; }
/**
 * 指定されたリポジトリとリファレンス（commit ID）からファイルを処理する関数
 * @param repoDir リポジトリのディレクトリ
 * @param ref リファレンス（commit ID）
 * @returns ファイル名と内容を持つオブジェクトの配列
 */
async function processFilesInArchive(repoDir: string, ref: string): Promise<FileContent[]> {
    const files: FileContent[] = [];

    await new Promise<void>(async (resolve, reject) => {
        try {
            const git: SimpleGit = simpleGit();
            const pass = new PassThrough();
            const extract = tar.extract();
            console.log(`Processing git in ${repoDir} at ${ref}...`);
            // Gitコマンドの標準出力をPassThroughに流す
            git.outputHandler((command, stdout, stderr) => {
                console.log(`Running command: ${command}`);
                stdout.pipe(pass);
            });

            // ファイルごとの処理
            extract.on('entry', (header, stream, next) => {
                const { name, size, type } = header;

                if (type === 'file') {
                    // console.log(`Processing file: ${name} (size: ${size} bytes)`);

                    const chunks: Buffer[] = [];
                    stream.on('data', (chunk) => {
                        // console.log(`Received ${chunk.length} bytes`);
                        chunks.push(chunk);
                    });

                    stream.on('end', () => {
                        // console.log(`Finished processing file: ${name} (${chunks.length} chunks)`);
                        const fileContent = Buffer.concat(chunks);
                        files.push({ name, content: fileContent });
                        next();
                    });

                    stream.on('error', (err) => {
                        console.error(`Error processing file ${name}:`, err);
                        next();
                    });
                } else {
                    // console.log(`Skipping non-file entry: ${name} (${type})`);
                    stream.resume();
                    next();
                }
            });

            console.log('Waiting for tar extraction to finish...');
            extract.on('finish', (...args: any) => {
                console.log('Finished extracting tar:', args);
                resolve(args);
            });
            extract.on('error', reject);
            pass.pipe(extract);
            await git.cwd(repoDir).raw(['archive', '--format=tar', ref]);
        } catch (err) {
            console.error(err);
            reject(err);
        }
    }).catch((err) => {
        console.error('Error processing files:', err);
        throw err;
    });

    return files;
}

export async function gitCat(orgKey: string, userId: string, ip: string, provider: string, gitlabProjectId: number, repoUrlWithoutAuth: string, repoUrlWithAuth: string, path_with_namespace: string, ref: string): Promise<FileContent[]> {
    const repoDire = `${GIT_REPOSITORIES}/${provider}/${path_with_namespace}`;
    console.log(`repoDire: ${repoDire}`);
    // gitリポジトリ操作前にDBで状態管理を行う
    const gitProject = await ds.transaction(async (tm) => {
        // (1) 該当Entityの取得 or 作成
        let gitProject = await tm.findOne(GitProjectEntity, {
            where: { provider, gitProjectId: gitlabProjectId },
            lock: { mode: "pessimistic_write" }, // (2) 悲観的ロックを取得
        });

        // (3) 無ければ新規作成
        if (!gitProject) {
            gitProject = new GitProjectEntity();
            gitProject.orgKey = orgKey;
            gitProject.provider = provider;
            gitProject.gitProjectId = gitlabProjectId;
            gitProject.status = GitProjectStatus.Cloning;
            gitProject.orgKey = orgKey;
            gitProject.createdBy = userId;
            gitProject.updatedBy = userId;
            gitProject.createdIp = ip;
            gitProject.updatedIp = ip;
            gitProject = await tm.save(gitProject);
        } else {
            // 既に別のプロセスが Cloning / Fetching ならどうするか？
            if ([GitProjectStatus.Cloning, GitProjectStatus.Fetching].includes(gitProject.status)) {
                // 待機 or エラー返却 or キューに格納などの設計が必要
                throw new Error(JSON.stringify({ status: 500, message: "Another process is already cloning/fetching this repository." }));
            }

            const isRefExists = await isRefExist(repoDire, ref);
            if (isRefExists) {
                // 存在するなら何もしない
                gitProject.status = GitProjectStatus.Normal;
            } else {
                // (4) まだ処理されていないなら status を Fetching にして更新
                gitProject.status = GitProjectStatus.Fetching;
                gitProject.updatedBy = userId;
                gitProject.updatedIp = ip;
                gitProject = await tm.save(gitProject);
            }
        }

        // (5) ここでトランザクションを終わらせるか、続けるかを検討
        // → ここでCOMMITして短期間でロックを解放する。実際の git clone/fetch はトランザクション外で行う。
        return gitProject;
    });

    // gitリポジトリ操作
    if ([GitProjectStatus.Normal].includes(gitProject.status)) {
        console.log(`Repository ${path_with_namespace} is already cloned.`);
        return await processFilesInArchive(repoDire, ref);
    } else if ([GitProjectStatus.Cloning, GitProjectStatus.Fetching].includes(gitProject.status)) {

        const e = await getExtApiClient(orgKey, provider);
        const proxy = await getProxyUrl(e.uriBase) || '';
        const git = simpleGit().env('http', proxy).env('https', proxy).env('sslVerify', 'false');
        try {
            if (gitProject.status === GitProjectStatus.Cloning) {
                console.log(`Cloning ${path_with_namespace}...`);
                await fs.promises.mkdir(path.dirname(`${GIT_REPOSITORIES}/${provider}/`), { recursive: true });
                console.log(`git clone ${repoUrlWithAuth} ${repoDire}`);;
                await git.clone(repoUrlWithAuth, repoDire);
                // .git/config内のURLに認証情報を含むURLを設定するとトークン期限切れに対応できなくなるので、認証情報を含まないURLに変更しておく。
                console.log(`git remote set-url origin ${repoUrlWithoutAuth}`);;
                await git.cwd(repoDire).remote(['set-url', 'origin', repoUrlWithoutAuth]);
                gitProject.status = GitProjectStatus.Normal;
                console.log(`Successfully cloned ${path_with_namespace}`);
            } else if (gitProject.status === GitProjectStatus.Fetching) {
                console.log(`Pulling ${path_with_namespace}...`);
                await git.cwd(repoDire).pull(repoUrlWithAuth);
                gitProject.status = GitProjectStatus.Normal;
                console.log(`Successfully pulled ${path_with_namespace}`);
            } else {
                throw new Error(`Invalid status: ${gitProject.status}`);
            }
        } catch (error) {
            gitProject.status = GitProjectStatus.Error;
            console.error(`Failed to ${gitProject.status} ${path_with_namespace}:`, error);
        }

        gitProject.updatedBy = userId;
        gitProject.updatedIp = ip;
        await ds.getRepository(GitProjectEntity).save(gitProject);
        // 
        return await processFilesInArchive(repoDire, ref);
    } else {
        throw new Error(`Invalid status: ${gitProject.status}`);
    }
}

export async function copyFromFirst(firstFileGroupId: string, project: ProjectEntity, orgKey: string, userId: string, ip: string): Promise<FileGroupEntity> {
    // すでにダウンロード済みの場合、最初の1個として登録されたものを再利用する
    return await ds.transaction(async tm => {
        const firstFileGroup = await tm.getRepository(FileGroupEntity).findOneOrFail({
            where: { orgKey, id: firstFileGroupId },
        });
        // 再作成するためにいくつかのプロパティを削除
        ['id', 'createdAt', 'updatedAt',].forEach(key => delete (firstFileGroup as any)[key]);
        firstFileGroup.projectId = project.id;
        firstFileGroup.isActive = true; // 全部有効にする
        firstFileGroup.orgKey = orgKey;
        firstFileGroup.createdBy = userId;
        firstFileGroup.updatedBy = userId;
        firstFileGroup.createdIp = ip;
        firstFileGroup.updatedIp = ip;
        const fileGroup = await tm.getRepository(FileGroupEntity).save(firstFileGroup);
        const files = await tm.getRepository(FileEntity).find({
            where: { orgKey, fileGroupId: firstFileGroupId },
        });
        const newFileGroupId = fileGroup.id;
        const savedfiles = await Promise.all(files.map(file => {
            // 再作成するためにいくつかのプロパティを削除
            ['id', 'createdAt', 'updatedAt',].forEach(key => delete (file as any)[key]);
            file.projectId = project.id;
            file.isActive = true; // 全部有効にする
            file.orgKey = orgKey;
            file.createdBy = userId;
            file.updatedBy = userId;
            file.createdIp = ip;
            file.updatedIp = ip;
            file.fileGroupId = newFileGroupId;
            // console.log('file:', file.filePath);
            return tm.getRepository(FileEntity).save(file);
        }));

        const fileAccesses = await tm.getRepository(FileAccessEntity).find({
            where: { orgKey, fileId: In(files.map(savedFile => savedFile.id)) },
        });
        // fileAccessはコピーじゃなくて全部権限OKで作っておく。
        await Promise.all(savedfiles.map(_file => {
            const fileAccess = new FileAccessEntity();
            fileAccess.orgKey = orgKey;
            fileAccess.fileId = _file.id;
            fileAccess.teamId = project.teamId;
            fileAccess.canRead = true;
            fileAccess.canWrite = true;
            fileAccess.canDelete = true;
            fileAccess.orgKey = orgKey;
            fileAccess.createdBy = userId;
            fileAccess.updatedBy = userId;
            fileAccess.createdIp = ip;
            fileAccess.updatedIp = ip;
            return tm.save(FileAccessEntity, fileAccess);
        }));
        // console.log('fileGroup:', fileGroup.id);

        return firstFileGroup;
    });
}

export async function gitFetchCommitId(
    orgKey: string,
    userId: string,
    ip: string,
    projectId: string,
    fileGroupType: FileGroupType,
    repositoryName: string,
    provider: string,
    descriptionObject: Object,
    gitProjectId: number,
    uriBase: string,
    http_url_to_repo: string,
    path_with_namespace: string,
    username: string,
    accessToken: string,
    commitId: string,
    user: UserTokenPayloadWithRole,
): Promise<{ fileGroup: FileGroupEntity, gitProjectCommit: GitProjectCommitEntity }> {
    console.log(`http_url_to_repo=${http_url_to_repo}`);
    const { repoUrlWithoutAuth, repoUrlWithAuth } = replaceDomain(http_url_to_repo, uriBase, username, accessToken);
    const files = await gitCat(orgKey, userId, ip, provider, Number(gitProjectId), repoUrlWithoutAuth, repoUrlWithAuth, path_with_namespace, commitId);
    const contents = files.map(file => ({
        filePath: file.name,
        base64Data: `data:application/octet-stream;base64,${Buffer.from(file.content).toString('base64')}`,
    }));

    // アップロードしてファイルグループを取得
    const uploadedFileGroupList = await uploadFileFunction(userId, projectId, contents, fileGroupType, orgKey, ip, user, repositoryName, JSON.stringify(descriptionObject));

    // 成功
    if (uploadedFileGroupList.length === 1) {
        const fileGroup = uploadedFileGroupList[0];

        // 新しい GitProjectCommitEntity を作成して紐づける
        let gitProjectCommit = new GitProjectCommitEntity();
        gitProjectCommit.orgKey = orgKey;
        gitProjectCommit.provider = provider;
        gitProjectCommit.gitProjectId = gitProjectId;
        gitProjectCommit.commitId = commitId;
        gitProjectCommit.fileGroupId = fileGroup.id;
        gitProjectCommit.createdIp = ip;
        gitProjectCommit.updatedIp = ip;
        gitProjectCommit.createdBy = userId;
        gitProjectCommit.updatedBy = userId;

        gitProjectCommit = await ds.getRepository(GitProjectCommitEntity).save(gitProjectCommit);
        return { fileGroup: uploadedFileGroupList[0], gitProjectCommit };
    } else {
        // return res.status(500).json({ error: 'Failed to upload files' });
        throw new Error('Failed to upload files');
    }
}

export function replaceDomain(uri: string, newUri: string, username: string, password: string): { repoUrlWithoutAuth: string, repoUrlWithAuth: string } {
    // console.log(`uri: ${uri}`);
    // URIをURLオブジェクトに変換
    const url = new URL(uri);
    const newUrl = new URL(newUri);
    // ドメイン部分（ホスト）を新しいドメインに変更
    url.protocol = newUrl.protocol;
    url.host = newUrl.host;
    url.port = newUrl.port;
    // url.pathname = `${newUrl.pathname}/${url.pathname}`.replaceAll(/\/\/*/g, '/');
    url.pathname = `${url.pathname}`.replaceAll(/\/\/*/g, '/');
    const repoUrlWithoutAuth = url.toString();
    // console.log(`repoUrlWithoutAuth: ${repoUrlWithoutAuth}`);

    url.username = encodeURIComponent(username);
    url.password = encodeURIComponent(password);

    const repoUrlWithAuth = url.toString();

    // console.log(`repoUrlWithAuth: ${repoUrlWithAuth}`);

    return { repoUrlWithoutAuth, repoUrlWithAuth };
}
