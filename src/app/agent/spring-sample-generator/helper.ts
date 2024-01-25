import { Utils } from '../../common/utils.js';

/**
 * OpenAPIのスキーマを構造体に変換する。
 * @param schema
 * @returns
 */
export function structToOpenApiSchema(struct: Record<string, string>): Record<string, any> {
    const properties: Record<string, any> = {};
    for (const [key, value] of Object.entries(struct)) {
        properties[key] = {
            type: value
        };
    }
    return {
        type: 'object',
        properties
    };
}


export function parseJavaMethodSignatureWithGenerics(signature: string): { returnType: string, methodName: string, parameters: { type: string, name: string }[] } {
    const pattern = /(\b\w+<.*?>|\b\w+)\s+(\w+)\((.*?)\)/;
    const match = signature.match(pattern);

    if (!match) {
        throw new Error('Invalid method signature');
    }

    const [, returnType, methodName, params] = match;

    // 引数リストをパースする正規表現。ジェネリックスを考慮。
    const paramPattern = /\s*(\b\w+<.*?>|\b\w+)\s+(\w+)\s*(,|$)/g;
    let paramMatch;
    const parameters = [];

    while ((paramMatch = paramPattern.exec(params)) !== null) {
        parameters.push({
            type: paramMatch[1].trim(),
            name: paramMatch[2].trim()
        });
    }

    return {
        returnType,
        methodName,
        parameters
    };
}


type MetaFieldType = { type: string, annotations: string[] };
type MetaFields = Record<string, MetaFieldType>;
type MetaModel = { classes: Record<string, { source: string, props: { type: string, name: string, annotations: string[] }[] }>, enums: Record<string, { source: string, values: string[] }>, entityList: string[] };

/**
 * JavaのDtoクラス用の簡易パーサー。クラス名とフィールド名とフィールド型のマップを返す。
 * @param code 
 * @returns 
 */
export function parseJavaCode(code: string, PACKAGE_NAME: string): MetaModel {
    // クラスを抽出
    const classRegex = /class\s+(\w+)\s*{([\s\S]*?)}/g;
    const fieldWithAnnotationRegex = /((?:\s*@\w+\s*(?:\([\s\S]*?\))?\s*)*)(\w+)\s+(\w+);/g;
    const classes: Record<string, { source: string, props: { type: string, name: string, annotations: string[] }[] }> = {};
    let match;
    while ((match = classRegex.exec(code)) !== null) {

        const className = match[1];
        const classBody = match[2];
        classes[className] = { source: classBody, props: [] };

        let fieldMatch;
        while ((fieldMatch = fieldWithAnnotationRegex.exec(classBody)) !== null) {
            const annotations = fieldMatch[1]
                .trim() // 余分な空白を削除
                .split(/\s+/) // アノテーションを分割
                .filter(a => a.startsWith('@')) // アノテーションのみをフィルタリング
                .map(a => a.trim()); // トリミングしてきれいにする
            const fieldType = fieldMatch[2];
            const fieldName = fieldMatch[3];
            classes[className].props.push({
                type: fieldType,
                name: fieldName,
                annotations: annotations
            });
        }
    }


    const enumRegex = /enum\s+(\w+)\s*{([\s\S]*?)}/g;
    const valueRegex = /\s*(\w+)\s*,/g;
    const enums: Record<string, { source: string, values: string[] }> = {};
    while ((match = enumRegex.exec(code)) !== null) {
        const enumName = match[1];
        const enumBody = match[2];
        enums[enumName] = { source: enumBody, values: [] };

        let valueMatch;
        while ((valueMatch = valueRegex.exec(enumBody)) !== null) {
            const value = valueMatch[1];
            enums[enumName].values.push(value);
        }
    }

    const classRegex2 = /^(?:class|enum)\s+(\w+)\s*{/g;
    let annos: string[] = [];
    // import jakarta.persistence.Column;
    // import jakarta.persistence.Entity;
    // import jakarta.persistence.EnumType;
    // import jakarta.persistence.Enumerated;
    // import jakarta.persistence.GeneratedValue;
    // import jakarta.persistence.GenerationType;
    // import jakarta.persistence.Id;
    const imports: string = Utils.trimLines(`
        import lombok.Data;
        import jakarta.persistence.*;
        import java.time.LocalDate;
        import java.time.LocalDateTime;
        import java.time.LocalTime;
        import java.util.List;
        import java.util.Map;
        import ${PACKAGE_NAME}.domain.enums.*;
    `);
    code.split('\n').forEach(line => {
        if (line.startsWith('@')) {
            annos.push(line.trim());
        }
        const match = line.match(classRegex2);
        if (match) {
            const className = match[0].split(' ')[1];
            if (classes[className]) {
                classes[className].source = `package ${PACKAGE_NAME}.domain.entity;\n\n${imports}\n\n${annos.join('\n')}\npublic class ${className} {\n${classes[className].source}\n}\n`;
            } else { }
            if (enums[className]) {
                enums[className].source = `package ${PACKAGE_NAME}.domain.enums;\n\n${annos.join('\n')}\npublic enum ${className} {\n${enums[className].source}\n}\n`;
            } else { }
            annos = []
        }
    });

    const entityList: string[] = [];
    Object.entries(classes).forEach(([className, classData]) => {
        if (classData.source.includes('@Entity')) {
            entityList.push(className);
        }
    });

    return { classes, enums, entityList };
}

// void flush();
// <S extends T> S saveAndFlush(S entity);
// <S extends T> List<S> saveAllAndFlush(Iterable<S> entities);
// @Deprecated
// default void deleteInBatch(Iterable<T> entities) {
// void deleteAllInBatch(Iterable<T> entities);
// void deleteAllByIdInBatch(Iterable<ID> ids);
// void deleteAllInBatch();
// @Deprecated
// T getOne(ID id);
// @Deprecated
// T getById(ID id);
// T getReferenceById(ID id);
// @Override
// <S extends T> List<S> findAll(Example<S> example);
// @Override
// <S extends T> List<S> findAll(Example<S> example, Sort sort);

export function javaServiceTemplateMap(
    serviceData: { [key: string]: { [key: string]: { name: string, method: string, endpoint: string, request: string, response: string, usageScreenIdList: string[], entityList: string[], serviceList: string[], documentList: string[] } } },
    reqResData: Record<string, Record<string, { type: string, name: string, validations?: string[] }[]>>,
    serviceDocsData: Record<string, string>,
    entityData: MetaModel,
    PACKAGE_NAME: string,
): Record<string, string> {
    const javaServiceTemplateMap: Record<string, string> = {};
    Object.keys(serviceData).forEach(serviceName => {
        const methodObject: { methodSignature: string }[] = [];
        Object.keys(serviceData[serviceName]).forEach(methodName => {
            const joinKey = Utils.safeFileName(`${serviceName}.${methodName}`);

            // serviceDataから必要な情報を抽出
            const methodData = serviceData[serviceName][methodName];
            const pascalServiceName = Utils.toPascalCase(serviceName);
            const pascalMethodName = Utils.toPascalCase(methodName);

            // reqResDataからリクエストとレスポンスの構造体を生成
            const interfaceTypeMap = reqResData[joinKey];

            const interfaceTypeList = Object.keys(interfaceTypeMap).filter(key => Object.keys(entityData.classes).indexOf(key) === -1).map(interfaceType => {
                const props = interfaceTypeMap[interfaceType].map(field => `\t\tprivate ${field.type} ${field.name};`).join('\n');
                return `
                \t@Data
                \tpublic static class ${interfaceType} {
                ${props}
                \t}`;
            }).join('\n');

            // serviceDocsDataからバックエンド処理詳細とビジネスロジックを抽出
            const match = serviceDocsData[joinKey].match(/## バックエンド処理詳細([\s\S]*?)## ビジネスロジック([\s\S]*?)$/);
            const backendDetail = (match ? match[1].trim() : '').split('\n').map(line => `\t * ${line}`).join('\n');
            const businessLogic = (match ? match[2].trim() : '').split('\n').map(line => `\t * ${line}`).join('\n');

            // 依存するエンティティとサービスをインポート
            const dependsEntityImportList = methodData.entityList.map(entityName => `import ${PACKAGE_NAME}.domain.entity.${Utils.toPascalCase(entityName)};`).join('\n');
            const dependsServiceImportList = methodData.serviceList.map(serviceName => `import ${PACKAGE_NAME}.domain.service.${Utils.toPascalCase(serviceName)};`).join('\n');
            const dependsEntityList = methodData.entityList.map(entityName => `\t@Autowired\n\tprivate ${Utils.toPascalCase(entityName)}Repository ${Utils.toCamelCase(entityName)}Repository;`).join('\n')
            const dependsServiceList = methodData.serviceList.map(serviceName => `\t@Autowired\n\tprivate ${Utils.toPascalCase(serviceName)} ${Utils.toCamelCase(serviceName)};`).join('\n')
            const serviceClassTemplate = Utils.trimLines(`
                package ${PACKAGE_NAME}.domain.service;
                
                import org.springframework.stereotype.Service;
                import org.springframework.beans.factory.annotation.Autowired;
                import org.springframework.http.HttpStatus;
                import lombok.Data;
                import lombok.RequiredArgsConstructor;
                import lombok.extern.slf4j.Slf4j;
                import com.example.demo.exception.CustomException;
                import com.example.demo.exception.ResourceNotFoundException;
                import java.util.List;
                import java.time.LocalDate;
                import java.time.LocalDateTime;
                import ${PACKAGE_NAME}.exception.ResourceNotFoundException;
                ${dependsEntityImportList}
                ${dependsServiceImportList}

                /**
                 * ${serviceName}
                 */
                @Service
                @Slf4j
                public class ${pascalServiceName} {
                ${interfaceTypeList}
                ${dependsEntityList}
                ${dependsServiceList}
                \t/**
                \t * ${methodData.name}
                \t * 
                \t * # 処理詳細
                ${backendDetail}
                \t * 
                \t * # ビジネスルール
                ${businessLogic}
                \t * 
                \t * @param request
                \t * @return 
                \t */
                \tpublic ${pascalServiceName}${pascalMethodName}ResponseDto ${Utils.toCamelCase(methodName)}(${pascalServiceName}${pascalMethodName}RequestDto request) {
                \t\t// TODO: 実装
                \t}
                }
            `);
            // 生成したテンプレートをキャッシュ
            javaServiceTemplateMap[joinKey] = serviceClassTemplate.replace(/\t/g, '    '); // タブをスペース4つに変換

            methodObject.push({
                methodSignature: Utils.trimLines(`
                    ${interfaceTypeList}
                    \t/**
                    \t * ${methodData.name}
                    \t */
                    \tpublic ${pascalServiceName}${pascalMethodName}ResponseDto ${Utils.toCamelCase(methodName)}(${pascalServiceName}${pascalMethodName}RequestDto request);
                `),
            });
        });

        // 生成したテンプレートをキャッシュ
        javaServiceTemplateMap[serviceName] = Utils.trimLines(`
            package ${PACKAGE_NAME}.domain.service;

            import lombok.Data;
            import java.util.List;
            import java.util.Map;
            import java.time.LocalDate;
            import java.time.LocalDateTime;
            import java.time.LocalTime;
            import ${PACKAGE_NAME}.domain.entity.*;
            import ${PACKAGE_NAME}.domain.enums.*;

            /**
             * ${serviceName}
             */
            public interface ${Utils.toPascalCase(serviceName)} {
            ${methodObject.map(method => method.methodSignature).join('\n')}
            }
        `);
    });
    return javaServiceTemplateMap;
}
export function javaServiceImplementsMap(
    serviceData: { [key: string]: { [key: string]: { name: string, method: string, endpoint: string, request: string, response: string, usageScreenIdList: string[], entityList: string[], serviceList: string[], documentList: string[] } } },
    reqResData: Record<string, Record<string, { type: string, name: string, validations?: string[] }[]>>,
    serviceDocsData: Record<string, string>,
    serviceImplData: Record<string, {
        additionalImports: string[],
        additionalInjections: string[],
        methodAnnotations: string[],
        methodBodyInnerCodes: string[],
    }>,
    entityData: MetaModel,
    PACKAGE_NAME: string,
): Record<string, { implement: string, interface: string, controller: string }> {
    const javaServiceSourceMap: Record<string, { implement: string, interface: string, controller: string }> = {};
    Object.keys(serviceData).forEach(serviceName => {
        const pascalServiceName = Utils.toPascalCase(serviceName);

        const methodObject: { name: string, pascalMethodName: string, interfaceTypeList: string, methodBody: string, methodSignature: string, controller: string }[] = [];
        const imports = new Set<string>();
        const injections = new Set<string>();
        Object.keys(serviceData[serviceName]).forEach(methodName => {
            const joinKey = Utils.safeFileName(`${serviceName}.${methodName}`);

            // serviceDataから必要な情報を抽出
            const methodData = serviceData[serviceName][methodName];
            const pascalMethodName = Utils.toPascalCase(methodName);

            // reqResDataからリクエストとレスポンスの構造体を生成
            const interfaceTypeMap = reqResData[joinKey];
            const interfaceTypeList = Object.keys(interfaceTypeMap).filter(key => Object.keys(entityData.classes).indexOf(key) === -1).map(interfaceType => {
                const props = interfaceTypeMap[interfaceType].map(field => `\t\tprivate ${field.type} ${field.name};`).join('\n');
                return Utils.trimLines(`
                \t@Data
                \tpublic static class ${interfaceType} {
                ${props}
                \t}`);
            }).join('\n');

            // serviceDocsDataからバックエンド処理詳細とビジネスロジックを抽出
            const match = serviceDocsData[joinKey].match(/## バックエンド処理詳細([\s\S]*?)## ビジネスロジック([\s\S]*?)$/);
            const backendDetail = (match ? match[1].trim() : '').split('\n').map(line => `\t * ${line}`).join('\n');
            const businessLogic = (match ? match[2].trim() : '').split('\n').map(line => `\t * ${line}`).join('\n');

            // 依存するエンティティとサービスをインポート
            imports.add(`${PACKAGE_NAME}.domain.service.${Utils.toPascalCase(serviceName)}`); // interface をインポート
            imports.add(`${PACKAGE_NAME}.exception.ResourceNotFoundException`); // ResourceNotFoundException をインポート
            imports.add(`${PACKAGE_NAME}.exception.CustomException`); // CustomException をインポート

            methodData.entityList.forEach(entityName => imports.add(`${PACKAGE_NAME}.domain.entity.${Utils.toPascalCase(entityName)}`));
            methodData.serviceList.forEach(serviceName => imports.add(`${PACKAGE_NAME}.domain.service.${Utils.toPascalCase(serviceName)}`));
            methodData.entityList.forEach(entityName => injections.add(`\t@Autowired\n\tprivate ${Utils.toPascalCase(entityName)}Repository ${Utils.toCamelCase(entityName)}Repository;`));
            methodData.serviceList.forEach(serviceName => injections.add(`\t@Autowired\n\tprivate ${Utils.toPascalCase(serviceName)} ${Utils.toCamelCase(serviceName)};`));

            serviceImplData[joinKey].additionalImports.forEach(imp => imports.add(imp.trim().replace(/^import /g, '').replace(/;$/g, '')));
            serviceImplData[joinKey].additionalInjections.forEach(inj => injections.add(inj.trim().replace(/\s+/g, ' ').replace(/^@Autowired\s/g, '\t@Autowired\n\t').replace(/;$/g, '') + ';'));

            const methodBody = Utils.trimLines(`
                \t/**
                \t * ${methodData.name}
                \t * 
                \t * @param request
                \t * @return 
                \t */
                ${serviceImplData[joinKey].methodAnnotations.map(anno => `\t${anno}`).join('\n') || Utils.TRIM_LINES_DELETE_LINE}
                \t@Override
                \tpublic ${pascalServiceName}${pascalMethodName}ResponseDto ${Utils.toCamelCase(methodName)}(${pascalServiceName}${pascalMethodName}RequestDto request) {
                ${serviceImplData[joinKey].methodBodyInnerCodes.map(code => `\t\t${code}`).join('\n')}
                \t}
                \t
            `);
            // console.log(methodBody);
            const methodSignature = Utils.trimLines(`
                ${interfaceTypeList}
                \t/**
                \t * ${methodData.name}
                \t * 
                \t * # 処理詳細
                ${backendDetail}
                \t * 
                \t * # ビジネスルール
                ${businessLogic}
                \t * 
                \t * @param request
                \t * @return 
                \t */
                \tpublic ${pascalServiceName}${pascalMethodName}ResponseDto ${Utils.toCamelCase(methodName)}(${pascalServiceName}${pascalMethodName}RequestDto request);
                \t
            `);
            const controller = Utils.trimLines(`
                \t/**
                \t * ${methodData.name}
                \t * 
                \t * @param request
                \t * @return 
                \t */
                \t@PostMapping("${methodData.endpoint}")
                \t@ResponseBody
                \tpublic ${pascalServiceName}.${pascalServiceName}${pascalMethodName}ResponseDto ${Utils.toCamelCase(methodName)}(@Valid ${pascalServiceName}.${pascalServiceName}${pascalMethodName}RequestDto request) {
                \t\treturn ${Utils.toCamelCase(serviceName)}.${Utils.toCamelCase(methodName)}(request);
                \t}
                \t
            `);
            methodObject.push({
                name: methodName,
                pascalMethodName,
                interfaceTypeList,
                methodBody,
                methodSignature,
                controller,
            });
        });

        imports.add(`org.springframework.stereotype.Service`);
        imports.add(`org.springframework.beans.factory.annotation.Autowired`);
        imports.add(`org.springframework.http.HttpStatus`);
        imports.add(`org.springframework.transaction.annotation.Transactional`);
        imports.add(`lombok.Data`);
        imports.add(`lombok.RequiredArgsConstructor`);
        imports.add(`lombok.extern.slf4j.Slf4j`);
        imports.add(`${PACKAGE_NAME}.domain.entity.*`);
        imports.add(`${PACKAGE_NAME}.domain.enums.*`);
        imports.add(`${PACKAGE_NAME}.domain.repository.*`);
        imports.add(`${PACKAGE_NAME}.exception.CustomException`);
        imports.add(`${PACKAGE_NAME}.exception.ResourceNotFoundException`);
        imports.add(`java.util.List`);
        imports.add(`java.util.Map`);
        imports.add(`java.time.LocalDate`);
        imports.add(`java.time.LocalDateTime`);
        imports.add(`java.time.LocalTime`);

        const injections0 = new Set<string>();
        injections.forEach(inj => {
            // console.log(inj);
            // const match = inj.match(/@Autowired\n\tprivate\s+(\w+)\s+(\w+);/);
            // if (match) {
            //     const [, type, name] = match;
            //     injections0.add(`\t@Autowired\n\tprivate ${type} ${name};`);
            // } else {
            //     injections0.add(inj);
            // }
        });

        // import jakarta.transaction.Transactional;
        const serviceClassImplement = Utils.trimLines(`
            package ${PACKAGE_NAME}.domain.service.impl;
            
            ${Array.from(imports).map(imp => 'import ' + imp + ';').join('\n')}

            /**
             * ${serviceName}Impl
             */
            @Service
            @Slf4j
            public class ${pascalServiceName}Impl implements ${pascalServiceName} {
            
            ${Array.from(injections).join('\n')}
            
            ${methodObject.map(method => method.methodBody).join('\n')}
            }
        `);

        const serviceInterfaceTemplate = Utils.trimLines(`
            package ${PACKAGE_NAME}.domain.service;

            import lombok.Data;
            import java.util.List;
            import java.util.Map;
            import java.time.LocalDate;
            import java.time.LocalDateTime;
            import java.time.LocalTime;
            import ${PACKAGE_NAME}.domain.entity.*;
            import ${PACKAGE_NAME}.domain.enums.*;

            /**
             * ${serviceName}
             */
            public interface ${pascalServiceName} {
            ${methodObject.map(method => method.methodSignature).join('\n')}
            }
        `);

        const controller = Utils.trimLines(`
            package ${PACKAGE_NAME}.domain.controller;

            import lombok.Data;
            import lombok.extern.slf4j.Slf4j;
            import java.util.List;
            import java.time.LocalDate;
            import java.time.LocalDateTime;
            import java.time.LocalTime;
            import org.springframework.beans.factory.annotation.Autowired;
            import org.springframework.web.bind.annotation.RestController;
            import org.springframework.web.bind.annotation.PostMapping;
            import org.springframework.web.bind.annotation.ResponseBody;
            import org.springframework.web.bind.annotation.RequestBody;
            import jakarta.validation.Valid;
            import ${PACKAGE_NAME}.domain.entity.*;
            import ${PACKAGE_NAME}.domain.service.${pascalServiceName};

            /**
             * ${serviceName}Controller
             */
            @RestController
            @Slf4j
            public class ${pascalServiceName}Controller {
            \t@Autowired
            \tprivate ${pascalServiceName} ${Utils.toCamelCase(serviceName)};
            ${methodObject.map(method => method.controller).join('\n')}
            }
        `);

        // 生成したテンプレートをキャッシュ
        javaServiceSourceMap[serviceName] = {
            implement: serviceClassImplement.replace(/\t/g, '    '), // タブをスペース4つに変換
            interface: serviceInterfaceTemplate.replace(/\t/g, '    '), // タブをスペース4つに変換
            controller: controller,
        };
    });
    // return serviceTemplate.replace('${serviceName}', serviceName).replace('${methods}', methods.join('\n'));
    return javaServiceSourceMap;
}










































const importMap = {
    // jakarta.persistence: 'jakarta.persistence.*',
    Column: 'jakarta.persistence.Column',
    MappedSuperclass: 'jakarta.persistence.MappedSuperclass',
    PrePersist: 'jakarta.persistence.PrePersist',
    PreUpdate: 'jakarta.persistence.PreUpdate',
    Enumerated: 'jakarta.persistence.Enumerated',
    EnumType: 'jakarta.persistence.EnumType',
    GeneratedValue: 'jakarta.persistence.GeneratedValue',
    GenerationType: 'jakarta.persistence.GenerationType',
    Id: 'jakarta.persistence.Id',
    Table: 'jakarta.persistence.Table',
    Temporal: 'jakarta.persistence.Temporal',
    TemporalType: 'jakarta.persistence.TemporalType',
    Transient: 'jakarta.persistence.Transient',
    Version: 'jakarta.persistence.Version',
    OneToMany: 'jakarta.persistence.OneToMany',
    ManyToOne: 'jakarta.persistence.ManyToOne',
    OneToOne: 'jakarta.persistence.OneToOne',
    JoinColumn: 'jakarta.persistence.JoinColumn',
    JoinTable: 'jakarta.persistence.JoinTable',
    Inheritance: 'jakarta.persistence.Inheritance',
    InheritanceType: 'jakarta.persistence.InheritanceType',
    DiscriminatorColumn: 'jakarta.persistence.DiscriminatorColumn',
    DiscriminatorType: 'jakarta.persistence.DiscriminatorType',
    DiscriminatorValue: 'jakarta.persistence.DiscriminatorValue',
    Entity: 'jakarta.persistence.Entity',

    // org.springframework.data.jpa.repository: 'org.springframework.data.jpa.repository.*',
    JpaRepository: 'org.springframework.data.jpa.repository.JpaRepository',
    Repository: 'org.springframework.stereotype.Repository',
    Service: 'org.springframework.stereotype.Service',
    Autowired: 'org.springframework.beans.factory.annotation.Autowired',
    HttpStatus: 'org.springframework.http.HttpStatus',
    Transactional: 'org.springframework.transaction.annotation.Transactional',

    // lombok: 'lombok.*',
    RequiredArgsConstructor: 'lombok.RequiredArgsConstructor',
    AllArgsConstructor: 'lombok.AllArgsConstructor',
    NoArgsConstructor: 'lombok.NoArgsConstructor',
    Data: 'lombok.Data',
    Slf4j: 'lombok.extern.slf4j.Slf4j',

    // com.example.demo.domain.enums: 'com.example.demo.domain.enums.*',
    CustomException: 'com.example.demo.exception.CustomException',
    ResourceNotFoundException: 'com.example.demo.exception.ResourceNotFoundException',

    // java.util: 'java.util.*',
    List: 'java.util.List',
    Map: 'java.util.Map',
    HashMap: 'java.util.HashMap',
    Optional: 'java.util.Optional',
    ArrayList: 'java.util.ArrayList',
    Set: 'java.util.Set',
    HashSet: 'java.util.HashSet',
    Arrays: 'java.util.Arrays',
    Collection: 'java.util.Collection',
    Comparator: 'java.util.Comparator',
    Iterator: 'java.util.Iterator',
    Collectors: 'java.util.stream.Collectors',
    Stream: 'java.util.stream.Stream',
    StreamSupport: 'java.util.stream.StreamSupport',
    Function: 'java.util.function.Function',
    Supplier: 'java.util.function.Supplier',
    Predicate: 'java.util.function.Predicate',
    BiPredicate: 'java.util.function.BiPredicate',
    Consumer: 'java.util.function.Consumer',
    BiConsumer: 'java.util.function.BiConsumer',
    OptionalInt: 'java.util.OptionalInt',
    OptionalLong: 'java.util.OptionalLong',
    OptionalDouble: 'java.util.OptionalDouble',

    // java.time: 'java.time.*',
    LocalDate: 'java.time.LocalDate',
    LocalDateTime: 'java.time.LocalDateTime',
    LocalTime: 'java.time.LocalTime',
    TemporalAdjusters: 'java.time.temporal.TemporalAdjusters',
    DayOfWeek: 'java.time.DayOfWeek',
    Period: 'java.time.Period',
    Duration: 'java.time.Duration',
    ZoneId: 'java.time.ZoneId',
    ZoneOffset: 'java.time.ZoneOffset',
    Instant: 'java.time.Instant',
    ZonedDateTime: 'java.time.ZonedDateTime',
    DateTimeFormatter: 'java.time.format.DateTimeFormatter',
    DateTimeParseException: 'java.time.format.DateTimeParseException',

};