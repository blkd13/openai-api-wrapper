// app.ts
import express, { NextFunction, Request, Response, Router } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import morgan from 'morgan';

import { graphqlHTTP } from 'express-graphql';

import { schema } from './schema.js';
import { authInviteRouter, authNoneRouter, authUserRouter } from './routes.js';

// import { Project } from './models/project-models.js';
// import { ProjectStatus } from './models/values.js';
// const p = new Project();
// p.name = 'test';
// p.status = ProjectStatus.NotStarted;
// p.stages = [];
// console.log('Project', JSON.stringify(p));
// console.log('Project', p);

const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(morgan('dev'));

// ルート設定開始
const rootRouter = Router();

// 認証不要ルート
rootRouter.use('/', authNoneRouter);
// ユーザー/パスワード認証が必要なルート
rootRouter.use('/user', authUserRouter);
// ワンタイムトークン認証が必要なルート
rootRouter.use('/invite', authInviteRouter);

app.use('/api', rootRouter);
// 認証系ルート設定終了

// GraphQL
app.use('/api/graphql', graphqlHTTP({
    schema: schema,
    graphiql: true,
}));

app.listen(3000, () => {
    console.log('Server is running on port 3000');
});

/**
import http from 'http';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
const httpServer = http.createServer(app);
interface MyContext {
    token?: string;
}
const typeDefs = `#graphql
  # Comments in GraphQL strings (such as this one) start with the hash (#) symbol.
  # This "Book" type defines the queryable fields for every book in our data source.
  type Book {
    title: String
    author: String
  }
  # The "Query" type is special: it lists all of the available queries that
  # clients can execute, along with the return type for each. In this
  # case, the "books" query returns an array of zero or more Books (defined above).
  type Query {
    books: [Book]
  }
`;
const books = [
    {
        title: 'The Awakening',
        author: 'Kate Chopin',
    },
    {
        title: 'City of Glass',
        author: 'Paul Auster',
    },
];
const resolvers = {
    Query: {
        books: () => books,
    },
};
const server = new ApolloServer<MyContext>({
    typeDefs,
    resolvers,
    plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
});
// Note you must call `start()` on the `ApolloServer`
// instance before passing the instance to `expressMiddleware`
await server.start();
app.use('/graphql', cors<cors.CorsRequest>(), express.json(), expressMiddleware(server));
await new Promise<void>((resolve) => httpServer.listen({ port: 3000 }, resolve));
console.log(`🚀 Server ready at http://localhost:3000/`);
 */
