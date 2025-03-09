// db.ts
import { DataSource } from "typeorm"
import { fileURLToPath } from 'url';
import path from 'path';
import { CustomNamingStrategy } from "../../config/naming-strategy.js";

const { TZ, TYPEORM_TYPE, TYPEORM_DATABASE, TYPEORM_HOST, TYPEORM_PORT, TYPEORM_USERNAME, TYPEORM_PASSWORD, TYPEORM_SCHEMA } = process.env;

// import.meta.urlからディレクトリパスを取得
const currentDir = path.dirname(fileURLToPath(import.meta.url));
console.log(`currentDir=${currentDir}`);

const sqlite = new DataSource({
    type: 'sqlite',
    database: './data/database.sqlite',
    entities: [path.join(currentDir, 'entity', '**', '*.entity.js'),],
    synchronize: true,
    logging: true,
    // extra: {
    //     pragma: {
    //         journal_mode: "wal"
    //     }
    // }
});

const postgres = new DataSource({
    type: TYPEORM_TYPE as 'postgres',
    database: TYPEORM_DATABASE,
    host: TYPEORM_HOST,
    port: Number(TYPEORM_PORT),
    username: TYPEORM_USERNAME,
    password: TYPEORM_PASSWORD,
    schema: TYPEORM_SCHEMA,
    synchronize: true,
    // logging: true,
    // useUTC: true,
    // dropSchema: true, // データ全消滅するから注意。
    entities: [path.join(currentDir, 'entity', '**', '*.entity.js'),],
    // migrations: [path.join(currentDir, 'migration', '**', '*.migration.js'),],
    // subscribers: [path.join(currentDir, 'subscribers', '**', '*.subscribers.js'),],
    namingStrategy: new CustomNamingStrategy(),
    extra: {
        timezone: 'Asia/Tokyo',
    }
});
export const ds = postgres;

await ds.initialize()
    .then(() => {
        console.log("Data Source has been initialized!")
    })
    .catch((err) => {
        console.error("Error during Data Source initialization", err)
    });


// CREATE TABLE users (
//     id INT AUTO_INCREMENT PRIMARY KEY,
//     name VARCHAR(255) NOT NULL,
//     email VARCHAR(255) NOT NULL UNIQUE,
//     password_hash VARCHAR(255) NOT NULL,
//     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//     updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
// );

// CREATE TABLE projects (
//     id INT AUTO_INCREMENT PRIMARY KEY,
//     name VARCHAR(255) NOT NULL,
//     description TEXT,
//     user_id INT NOT NULL,
//     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//     updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
//     FOREIGN KEY (user_id) REFERENCES users(id)
// );

// CREATE TABLE document_elements (
//     id INT AUTO_INCREMENT PRIMARY KEY,
//     project_id INT NOT NULL,
//     name VARCHAR(255) NOT NULL,
//     content TEXT,
//     element_type VARCHAR(255) NOT NULL,
//     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//     updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
//     FOREIGN KEY (project_id) REFERENCES projects(id)
// );

// CREATE TABLE relationships (
//     id INT AUTO_INCREMENT PRIMARY KEY,
//     source_element_id INT NOT NULL,
//     target_element_id INT NOT NULL,
//     type VARCHAR(255) NOT NULL,
//     description TEXT,
//     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//     updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
//     FOREIGN KEY (source_element_id) REFERENCES document_elements(id),
//     FOREIGN KEY (target_element_id) REFERENCES document_elements(id)
// );

// CREATE TABLE comments (
//     id INT AUTO_INCREMENT PRIMARY KEY,
//     document_element_id INT NOT NULL,
//     user_id INT NOT NULL,
//     content TEXT NOT NULL,
//     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//     updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
//     FOREIGN KEY (document_element_id) REFERENCES document_elements(id),
//     FOREIGN KEY (user_id) REFERENCES users(id)
// );
