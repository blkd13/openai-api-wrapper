// db.ts

import { DataSource } from "typeorm"
import { fileURLToPath } from 'url';
import path from 'path';

// import.meta.urlからディレクトリパスを取得
const currentDir = path.dirname(fileURLToPath(import.meta.url));
console.log(`currentDir=${currentDir}`);

export const ds = new DataSource({
    type: 'sqlite',
    database: './data/database.sqlite',
    entities: [
        path.join(currentDir, 'entity', '**', '*.entity.js'),
    ],
    synchronize: true,
    logging: true,
})

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
