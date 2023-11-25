#!/usr/bin/env node

// typescriptのデバッグ用にsource-map-supportを読み込む
import 'source-map-support/register.js'

import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { ArgumentsCamelCase } from 'yargs';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';

const messageJp = {
    usage: '使い方',
    epilog: '以上',
    version: 'バージョン番号を表示する',
    demandCommand: 'コマンドを指定してください',
    example: {
        batch: 'エージェントを起動する',
        server: 'REST APIサーバーを起動する',
        generate: 'ひな型を作成する',
    },
    agent: 'エージェント名',
    allowLocalFiles: 'ローカルファイルへのアクセスを許可するフラグ',
    cors: 'CORSを許可するフラグ',
    warningHost: (host: string) => `${host} ローカルホスト以外のホスト名でサーバーを起動します。セキュリティ上危険なので十分注意してください。`,
    warningAllowLocalFiles: 'VisionAPI用のローカルファイルアクセスが有効です。セキュリティ上危険なので十分注意してください。',
    warningCors: 'CORSが有効です。セキュリティ上危険なので十分注意してください。',
    generateAgent: 'エージェントのひな型を作成する',
    genType: '生成する種類',
    genName: '生成する名前',
};
const messageEn = {
    usage: 'Usage',
    epilog: 'This is the end',
    version: 'Show version number',
    demandCommand: 'You need at least one command before moving on',
    example: {
        batch: 'Start agent',
        server: 'Start REST API server',
        generate: 'Generate template',
    },
    agent: 'agent name',
    allowLocalFiles: 'Allow local file access',
    cors: 'Allow CORS',
    warningHost: (host: string) => `${host} You are starting the server with a host name other than localhost. This is dangerous from a security point of view, so be careful.`,
    warningAllowLocalFiles: 'Vision API local file access is enabled. This is dangerous from a security point of view, so be careful.',
    warningCors: 'CORS is enabled. This is dangerous from a security point of view, so be careful.',
    generateAgent: 'Generate agent template',
    genType: 'Generate type',
    genName: 'Generate name',
};
const message = messageJp;

const argv = yargs(hideBin(process.argv))
    .scriptName('oaw')
    .usage(`${message.usage}: $0 <command> [options]`)
    // .version('v', message.version, '0.0.1')
    .help()
    // .strict() // 引数の数が合わないとか知らないオプションとかでエラーにするかどうか
    .epilog(message.epilog) // ヘルプの最後に表示される
    .showHelpOnFail(true)
    .demandCommand(1, message.demandCommand)
    // batch 用の設定 ------------------------------------------------------------------------------
    .example('$0 batch sample', `${message.example.batch} "sample"`)
    .command(
        ['batch <agent> [step]', 'b'], message.example.batch,
        (yargs) => yargs
            .positional('agent', { describe: message.agent, type: 'string', demandOption: true })
            .positional('step', { describe: 'step', type: 'number', default: 0 }),
        (argv: ArgumentsCamelCase<{
            agent: string,
            step?: number,
        }>) => {
            // batchの実行
            import(`./main/main-batch.js`).then(async (m) => { m.main(argv.agent as string || ''); });
        })
    // rest api server 用の設定 --------------------------------------------------------------------
    .example('$0 server -p 3000 -h localhost --cors', `${message.example.server}`)
    .command(
        ['server', 's'], message.example.server,
        (yargs) => yargs
            .option('port', { alias: 'p', describe: 'port number', type: 'number', default: 3000 })
            .option('host', { alias: 'h', describe: 'host name', type: 'string', default: 'localhost' })
            .option('allow-local-files', { alias: 'l', describe: message.allowLocalFiles, type: 'boolean', default: false })
            .option('cors', { describe: message.cors, type: 'boolean', default: false }),
        (argv: ArgumentsCamelCase<{
            port: number,
            host: string,
            allowLocalFiles: boolean,
            cors: boolean,
        }>) => {
            if (['localhost', '127.0.0.1'].indexOf(argv.host as string) === -1) {
                console.log(chalk.red(message.warningHost(argv.host as string)));
            } else { }
            if (argv.allowLocalFiles) {
                console.log(chalk.red(message.warningAllowLocalFiles));
            } else { }
            if (argv.cors) {
                console.log(chalk.red(message.warningCors));
            } else { }
            // serverの実行
            import(`./main/main-server.js`).then(async (m) => { m.main(argv.host, argv.port, argv.allowLocalFiles, argv.cors); });
        })
    // generate 用の設定 ---------------------------------------------------------------------------
    .example('$0 generate agent sample', message.generateAgent)
    .command(
        ['generate <gentype> <name>', 'g', `gen`], message.example.generate,
        (yargs) => yargs
            .positional('gentype', { describe: message.genType, type: 'string', demandOption: true, choices: ['agent', 'intent', 'entity', 'action', 'form', 'story', 'domain', 'config'] })
            .positional('name', { describe: message.genName, type: 'string', demandOption: true }),
        (argv: ArgumentsCamelCase<{
            gentype: string,
            name: string,
        }>) => {
            console.log('generate', argv.gentype, argv.name);
            import(`./main/main-generate.js`).then(async (m) => { m.main(argv.gentype as string || '', argv.name as string || ''); });
        })
    .recommendCommands()
    .completion()
    .parseSync();
