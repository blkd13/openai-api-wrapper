const source = `
server:
    port: 8080
    servlet:
        context-path: /{{project-name}}/api
        session.cookie.name: MYID
       
spring:
    devtools:
        livereload:
            enabled: true
        restart:
            enabled: true
    batch:
        initialize-schema: always
    datasource:
        driver-class-name: org.postgresql.Driver
        url: jdbc:postgresql://localhost:5432/postgres?currentSchema={{project_name}}
        username: postgres
        password: postgres
        hikari:
            maximum-pool-size: 2
            connection-timeout: 1000
#        initialization-mode: always
#    jpa:
#        database: Postgres # JPAを使う場合は任意。なかったら自動判断
#        hibernate.ddl-auto: update
    # "MB" or "KB" 
    servlet.multipart:
        max-file-size: 10MB
        max-request-size: 10MB
    
    jackson:
        deserialization:
            FAIL_ON_IGNORED_PROPERTIES: false
            FAIL_ON_UNKNOWN_PROPERTIES: false
    #    # 値がnullのプロパティーを出力しない
    #    default-property-inclusion: NON_NULL
    #    # JSON出力時に改行・インデントを入れる
    #    serialization:
    #        INDENT_OUTPUT: true
        
logging.level:
    root: info
    {{packageName}}: debug
#    file.name: logfile
`
export default source.trim();