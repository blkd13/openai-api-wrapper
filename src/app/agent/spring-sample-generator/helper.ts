import { Utils } from '../../common/utils.js';
import { JAVA_FQCN_MAP, javaTypeToTypescript, unmatchedType } from './constant.js';

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

export const LITERAL_TYPE_REMAP: { [key: string]: string } = {
    int: 'Integer',
    long: 'Long',
    float: 'Float',
    double: 'Double',
    boolean: 'Boolean',
    char: 'Character',
    byte: 'Byte',
    short: 'Short',
};

// Date, Time, DateTimeの場合は、@Column(columnDefinition)を付与
export const TIME_TYPE_REMAP: { [key: string]: string } = {
    Date: 'LocalDate',
    Time: 'LocalTime',
    DateTime: 'LocalDateTime',
    Timestamp: 'LocalDateTime',
    LocalDate: 'LocalDate',
    LocalTime: 'LocalTime',
    LocalDateTime: 'LocalDateTime',
};
export const TIME_TYPE_REMAP_REGEXP: RegExp[] = Object.keys(TIME_TYPE_REMAP).map(key => new RegExp(`\W${key}\W`, 'g'));
export const TIME_TYPE_COLUMN_DEFINITION: { [key: string]: string } = {
    LocalDate: 'DATE',
    LocalTime: 'TIME',
    LocalDateTime: 'TIMESTAMP',
};

export type EntityValueObjectType = {
    type: 'entity' | 'valueObject', imports: string[], annotations: string[], source: string, mdTable: string, relatedClasses: string[],
    props: { type: string, strippedType: string, name: string, annotations: string[], isOptional: boolean, description: string }[]
};
export type EnumType = { type: 'enum', source: string, mdTable: string, values: string[] };
export type EntityDetailFilledType = {
    classes: Record<string, EntityValueObjectType>,
    enums: Record<string, EnumType>,
    entityNameList: string[], valueObjectNameList: string[], enumNameList: string[],
};

export type EntityValueObjectEnumSimpleType = { classes: Record<string, { source: string, props: { type: string, name: string, annotations: string[], description: string }[] }>, enums: Record<string, { source: string, values: string[] }> };

export interface ServiceMethod {
    name: string,
    method: string,
    endpoint: string,
    pathVariableList: string[],
    request: string,
    response: string,
    usageScreenIdList: string[],
    entityList: string[],
    serviceList: string[],
    documentList: string[],
}

/**
 * JavaのDtoクラス用の簡易パーサー。クラス名とフィールド名とフィールド型のマップを返す。
 * @param code 
 * @returns 
 */
export function parseJavaModelCode(code: string, PACKAGE_NAME: string): EntityValueObjectEnumSimpleType {
    // クラスを抽出
    const classRegex = /class\s+(\w+)\s*{([\s\S]*?)}/g;
    const fieldWithAnnotationRegex = /((?:\s*@\w+\s*(?:\([\s\S]*?\))?\s*)*)(\w+)\s+(\w+);/g;
    const classes: Record<string, { source: string, props: { type: string, name: string, annotations: string[], description: string }[] }> = {};
    let match;
    while ((match = classRegex.exec(code)) !== null) {

        const className = Utils.toPascalCase(match[1]);
        const classBody = match[2];
        classes[className] = { source: classBody, props: [] };
        JAVA_FQCN_MAP[className] = `${PACKAGE_NAME}.domain.entity.${className}`;

        let fieldMatch;
        while ((fieldMatch = fieldWithAnnotationRegex.exec(classBody)) !== null) {
            const annotations = fieldMatch[1]
                .trim() // 余分な空白を削除
                .split(/\s+/) // アノテーションを分割
                .filter(a => a.startsWith('@')) // アノテーションのみをフィルタリング
                .map(a => a.trim()); // トリミングしてきれいにする
            let fieldType = fieldMatch[2];
            const fieldName = Utils.toCamelCase(fieldMatch[3]);

            // List<>の場合はジェネリクスの中身を取り出す
            const innerTypeMatch = fieldType.match(/<(.+)>/);
            if (innerTypeMatch) {
                fieldType = innerTypeMatch[1];
            }
            // リテラルだったらオブジェクト型に変換
            LITERAL_TYPE_REMAP[fieldType] && (fieldType = fieldType.replace(fieldType, LITERAL_TYPE_REMAP[fieldType]));

            classes[className].props.push({
                type: fieldType,
                name: fieldName,
                annotations: annotations,
                description: '',
            });
        }
    }

    const enumRegex = /enum\s+(\w+)\s*{([\s\S]*?)}/g;
    const valueRegex = /\s*(\w+)\s*,?/g;
    const enums: Record<string, { source: string, values: string[] }> = {};
    while ((match = enumRegex.exec(code)) !== null) {
        const enumName = Utils.toPascalCase(match[1]);
        const enumBody = match[2];
        enums[enumName] = { source: enumBody, values: [] };
        JAVA_FQCN_MAP[enumName] = `${PACKAGE_NAME}.domain.enums.${enumName}`;

        let valueMatch;
        while ((valueMatch = valueRegex.exec(enumBody)) !== null) {
            const value = valueMatch[1];
            enums[enumName].values.push(value);
            // console.log(enumName, value);
        }
    }

    return { classes, enums };
}

export class DtoClass {
    constructor(
        public name: string,
        public fields: { name: string, type: string, annotations: string[], description: string }[] = [],
        public methods: { name: string, type: string, annotations: string[], description: string, args: string[], body: string }[] = [],
        public innerClasses: DtoClass[] = [],
        public imports: string[] = [],
    ) { }
}

/**
 * サービスの型（メソッド名と入出力の型）が決まったら
 * service interface と controller を生成する。
 * @param serviceData 
 * @param serviceModel 
 * @param serviceDocs 
 * @param entityData 
 * @param PACKAGE_NAME 
 * @returns 
 */
export function javaInterfaceMap(
    serviceData: { [key: string]: { [key: string]: ServiceMethod } },
    serviceModel: Record<string, DtoClass>,
    serviceDocs: Record<string, string>,
    entityData: EntityDetailFilledType,
    PACKAGE_NAME: string,
): Record<string, { interface: string, controller: string }> {
    const javaServiceSourceMap: Record<string, { interface: string, controller: string }> = {};
    const entityValueObjectNameList = Object.keys(entityData.classes);
    Object.keys(serviceData).forEach(serviceName => {
        const pascalServiceName = Utils.toPascalCase(serviceName);

        const methodObject: { methodName: string, methodSignature: string, controller: string, }[] = [];

        const serviceImports = new Set<string>();
        const controllerImports = new Set<string>();

        Object.keys(serviceData[serviceName]).forEach(methodName => {
            const joinKey = Utils.safeFileName(`${serviceName}.${methodName}`);

            // serviceDataから必要な情報を抽出
            const methodData = serviceData[serviceName][methodName];
            const pascalMethodName = Utils.toPascalCase(methodName);

            // reqResDataからリクエストとレスポンスの構造体を生成
            function modelToJava(dtoClass: DtoClass, depth: number = 1): string {
                const indent = '\t'.repeat(depth);
                // innerClassで、同名のEntity、もしくはValueObjectがある場合はEntity/ValueObjectを継承させる
                const extendsEntity = entityValueObjectNameList.includes(dtoClass.name) ? `extends ${PACKAGE_NAME}.domain.entity.${dtoClass.name}` : '';
                serviceImports.add(dtoClass.name);
                const annos = [];
                annos.push('Data');
                annos.push('NoArgsConstructor');
                if (dtoClass.fields && dtoClass.fields.length > 0) {
                    annos.push('AllArgsConstructor');
                    serviceImports.add('AllArgsConstructor');
                }
                if (extendsEntity) {
                    annos.push('EqualsAndHashCode(callSuper = false)');
                    serviceImports.add(`EqualsAndHashCode`);
                }
                // serviceImportsに追加
                annos.forEach(anno => serviceImports.add(anno));
                const annoString = annos.map(anno => `${indent}@${anno}`).join('\n');


                // fieldの型をserviceImportsに追加
                dtoClass.fields.forEach(field => {
                    if (field.type.includes('<')) {
                        // ジェネリクスの場合は分解して追加
                        field.type.split(/[<,>]/).filter(t => t.trim()).forEach(t => serviceImports.add(t.trim()));
                    } else {
                        serviceImports.add(field.type);
                    }
                    // アノテーションの型をserviceImportsに追加
                    field.annotations.forEach(anno => serviceImports.add(anno.trim().replace(/^@/g, '').replace(/\(.*/g, '')));
                });
                return Utils.trimLines(`
                    ${annoString}
                    ${indent}public static class ${dtoClass.name} ${extendsEntity} {
                    ${dtoClass.fields.map(field => field.annotations.map(anno => `\n${indent}\t${anno}`).join('') + `\n${indent}\tprivate ${field.type} ${field.name};`).join('') || '\n\t\t// no fields'}
                    ${dtoClass.innerClasses.map(innerClass => `\n${modelToJava(innerClass, depth + 1)}`).join('\n') || Utils.TRIM_LINES_DELETE_LINE}
                    ${indent}}
                `);
            }
            const interfaceTypeList = serviceModel[serviceName].innerClasses
                .filter(innerClass => innerClass.name.startsWith(`${pascalServiceName}${pascalMethodName}`))
                // .filter(key => Object.keys(entityData.classes).indexOf(key) === -1)
                .map(innerClass => modelToJava(innerClass)).join('\n\n');

            // serviceDocsDataから処理概要を抽出（インターフェースのコメントに使用）
            const match0 = serviceDocs[joinKey].match(/## 機能概要([\s\S]*?)## API仕様/);
            const description = (match0 ? match0[1].trim() : '').split('\n').map(line => `\t * ${line}`).join('\n');

            // serviceDocsDataからバックエンド処理詳細とビジネスロジックを抽出（実装のコメントに使用）
            const match = serviceDocs[joinKey].match(/## バックエンド処理詳細([\s\S]*?)## ビジネスロジック([\s\S]*?)$/);
            const backendDetail = (match ? match[1].trim() : '').split('\n').map(line => `\t * ${line}`).join('\n');
            const businessLogic = (match ? match[2].trim() : '').split('\n').map(line => `\t * ${line}`).join('\n');

            /**
             * サービスのインターフェースを生成
             */
            const methodSignature = Utils.trimLines(`
                ${interfaceTypeList}
                \t
                \t/**
                \t * ${methodData.name}
                \t * 
                ${description}
                \t * 
                ${businessLogic}
                \t *
                \t * @param request
                \t * @return 
                \t */
                \tpublic ${pascalServiceName}${pascalMethodName}ResponseDto ${Utils.toCamelCase(methodName)}(${pascalServiceName}${pascalMethodName}RequestDto request);
                \t
            `);

            /**
             * ControllerはHttpメソッドによって引数の受け取り方が異なるのでちょっと複雑
             * 
             * GET, DELETEの場合はpathVariableを受け取ってリクエストボディに変換する
             * POST, PUT, PATCHの場合はpathVariableが無いように調整済みなのでリクエストボディのみを受け取る
             */
            // Controller用のメソッドを生成
            let controllerMethodSignature;
            // requestDtoのモデルからフィールドを取得する。
            const reqDto = serviceModel[serviceName].innerClasses.find(innerClass => innerClass.name === `${pascalServiceName}${pascalMethodName}RequestDto`) || { fields: [] };
            // console.log(methodData.method + ' '.repeat(4 - methodData.method.length), methodData.endpoint, methodData.pathVariableList, methodData.request);
            if (['POST', 'PUT', 'PATCH'].includes(methodData.method)) {
                // POST, PUT, PATCHの場合はpathVariableが無いように調整済みなのでリクエストボディのみを受け取る
                controllerMethodSignature = Utils.trimLines(`
                    \tpublic ${pascalServiceName}.${pascalServiceName}${pascalMethodName}ResponseDto ${Utils.toCamelCase(methodName)}(@Valid @RequestBody ${pascalServiceName}.${pascalServiceName}${pascalMethodName}RequestDto request) {
                    \t\treturn ${Utils.toCamelCase(serviceName)}.${Utils.toCamelCase(methodName)}(request);
                    \t}
                `);
                controllerImports.add('RequestBody');
                controllerImports.add('Valid');
            } else {
                // GET, DELETEの場合はpathVariableかrequestParamを受け取ってリクエストボディに変換する
                const args = methodData.pathVariableList.map((_, index) => ({ argType: 'path', name: reqDto.fields[index].name, type: reqDto.fields[index].type, argString: `@PathVariable("${reqDto.fields[index].name}") ${reqDto.fields[index].type} ${reqDto.fields[index].name}` }));
                const pathVariableNames = methodData.pathVariableList.map((_, index) => reqDto.fields[index].name);
                reqDto.fields.forEach(field => {
                    if (pathVariableNames.indexOf(field.name) === -1) {
                        // pathVariableに含まれていない場合はqueryParameterとして受け取る
                        args.push({ argType: 'query', name: field.name, type: field.type, argString: `@RequestParam("${field.name}") ${field.type} ${field.name}` });
                        controllerImports.add('RequestParam');
                    } else {
                        // pathVariableに含まれているので、ここでは何もしない。
                    }
                    // ジェネリクスの場合は分解して追加
                    field.type.split(/[<,>]/).filter(t => t.trim()).forEach(t => controllerImports.add(field.type));
                });
                controllerMethodSignature = Utils.trimLines(`
                    \tpublic ${pascalServiceName}.${pascalServiceName}${pascalMethodName}ResponseDto ${Utils.toCamelCase(methodName)}(${args.map((arg) => arg.argString).join(', ')}) {
                    \t\t${pascalServiceName}.${pascalServiceName}${pascalMethodName}RequestDto request = new ${pascalServiceName}.${pascalServiceName}${pascalMethodName}RequestDto();
                    ${args.map((_, index) => `\t\trequest.set${Utils.toPascalCase(reqDto.fields[index].name)}(${reqDto.fields[index].name});`).join('\n')}
                    \t\treturn ${Utils.toCamelCase(serviceName)}.${Utils.toCamelCase(methodName)}(request);
                    \t}
                `);
                if (methodData.pathVariableList.length > 0) controllerImports.add('PathVariable');
            }

            const controller = Utils.trimLines(`
                \t/**
                \t * ${methodData.name}
                \t * 
                \t * @param request
                \t * @return 
                \t */
                \t@${Utils.toPascalCase(methodData.method)}Mapping("${methodData.endpoint}")
                \t@ResponseBody
                ${controllerMethodSignature}
                \t
            `);
            controllerImports.add(`${Utils.toPascalCase(methodData.method)}Mapping`);
            controllerImports.add('ResponseBody');

            methodObject.push({
                methodName,
                methodSignature,
                controller,
            });
        });

        const serviceImportString = Array.from(serviceImports).map(imp => JAVA_FQCN_MAP[imp]).filter(imp => imp).map(imp => `import ${imp};\n`).join('');
        const serviceInterfaceTemplate = Utils.trimLines(`
            package ${PACKAGE_NAME}.domain.service;

            ${serviceImportString || Utils.TRIM_LINES_DELETE_LINE}
            /**
             * ${serviceName}
             */
            public interface ${pascalServiceName} {
            
            ${methodObject.map(method => method.methodSignature).join('\n')}
            }
        `);

        controllerImports.add('RestController');
        // controllerImports.add('Slf4j');
        controllerImports.add('Autowired');
        const controllerImportString = Array.from(controllerImports).map(imp => JAVA_FQCN_MAP[imp]).filter(imp => imp).map(imp => `import ${imp};\n`).join('');
        const controller = Utils.trimLines(`
            package ${PACKAGE_NAME}.domain.controller;

            ${controllerImportString || Utils.TRIM_LINES_DELETE_LINE}
            import ${PACKAGE_NAME}.domain.service.${pascalServiceName};

            /**
             * ${serviceName}Controller
             */
            @RestController
            // @Slf4j
            public class ${pascalServiceName}Controller {
            \t@Autowired
            \tprivate ${pascalServiceName} ${Utils.toCamelCase(serviceName)};
            
            ${methodObject.map(method => method.controller).join('\n')}
            }
        `);

        // 生成したテンプレートをキャッシュ
        javaServiceSourceMap[serviceName] = {
            interface: serviceInterfaceTemplate.replace(/\t/g, '    '), // タブをスペース4つに変換
            controller: controller.replace(/\t/g, '    '),              // タブをスペース4つに変換
        };
    });
    // return serviceTemplate.replace('${serviceName}', serviceName).replace('${methods}', methods.join('\n'));
    return javaServiceSourceMap;
}

/**
 * サービスの実装を生成するためのプロンプトに使う用のソース。
 * 複数メソッドを一気に作らせると出力が安定しないので、
 * 1メソッドだけ出力させるために1サービス1メソッドのテンプレートを作る。
 * @param serviceList 
 * @param serviceModel 
 * @param serviceDocs 
 * @param entityData 
 * @param PACKAGE_NAME 
 * @returns 
 */
export function javaServiceTemplateMap(
    serviceList: { [key: string]: { [key: string]: ServiceMethod } },
    serviceModel: Record<string, DtoClass>,
    serviceDocs: Record<string, string>,
    entityData: EntityDetailFilledType,
    PACKAGE_NAME: string,
): Record<string, string> {
    const javaServiceTemplateMap: Record<string, string> = {};
    Object.keys(serviceList).forEach(serviceName => {
        const methodObject: { methodSignature: string }[] = [];
        Object.keys(serviceList[serviceName]).forEach(methodName => {
            const joinKey = Utils.safeFileName(`${serviceName}.${methodName}`);

            // serviceDataから必要な情報を抽出
            const methodData = serviceList[serviceName][methodName];
            const pascalServiceName = Utils.toPascalCase(serviceName);
            const pascalMethodName = Utils.toPascalCase(methodName);

            const serviceImports = new Set<string>();

            // reqResDataからリクエストとレスポンスの構造体を生成
            function modelToJava(dtoClass: DtoClass, depth: number = 1): string {
                const indent = '\t'.repeat(depth);
                serviceImports.add(dtoClass.name);
                serviceImports.add('Data');
                serviceImports.add('NoArgsConstructor');
                // fieldの型をserviceImportsに追加
                dtoClass.fields.forEach(field => {
                    if (field.type.includes('<')) {
                        // ジェネリクスの場合は分解して追加
                        field.type.split(/[<,>]/).filter(t => t.trim()).forEach(t => serviceImports.add(t.trim()));
                    } else {
                        serviceImports.add(field.type);
                    }
                    // アノテーションの型をserviceImportsに追加
                    field.annotations.forEach(anno => serviceImports.add(anno.trim().replace(/^@/g, '').replace(/\(.*/g, '')));
                });

                return Utils.trimLines(`
                    ${indent}@Data
                    ${indent}@NoArgsConstructor
                    ${indent}public static class ${dtoClass.name} {
                    ${dtoClass.fields.map(field => field.annotations.map(anno => `\n${indent}\t${anno}`) + `\n${indent}\tprivate ${field.type} ${field.name};`).join('') || '\n\t\t// no fields'}
                    ${dtoClass.innerClasses.map(innerClass => `\n${modelToJava(innerClass, depth + 1)}`).join('\n') || Utils.TRIM_LINES_DELETE_LINE}
                    ${indent}}
                `);
            }

            const interfaceTypeList = serviceModel[serviceName].innerClasses
                .filter(innerClass => innerClass.name.startsWith(`${pascalServiceName}${pascalMethodName}`))
                // .filter(key => Object.keys(entityData.classes).indexOf(key) === -1)
                .map(innerClass => modelToJava(innerClass)).join('\n\n');

            // serviceDocsDataからバックエンド処理詳細とビジネスロジックを抽出
            const match1 = serviceDocs[joinKey].match(/## バックエンド処理詳細([\s\S]*?)## ビジネスロジック([\s\S]*?)$/);
            const backendDetail = (match1 ? match1[1].trim() : '').split('\n').map(line => `\t * ${line}`).join('\n');
            const businessLogic = (match1 ? match1[2].trim() : '').split('\n').map(line => `\t * ${line}`).join('\n');

            // 依存するエンティティとサービスをインポート
            const dependsEntityImportList = methodData.entityList.map(entityName => `import ${PACKAGE_NAME}.domain.entity.${Utils.toPascalCase(entityName)};`).join('\n');
            const dependsRepositoryImportList = methodData.entityList.map(entityName => `import ${PACKAGE_NAME}.domain.repository.${Utils.toPascalCase(entityName)}Repository;`).join('\n');
            const dependsServiceImportList = methodData.serviceList.map(serviceName => `import ${PACKAGE_NAME}.domain.service.${Utils.toPascalCase(serviceName)};`).join('\n');
            const dependsEntityList = methodData.entityList.map(entityName => `\t@Autowired\n\tprivate ${Utils.toPascalCase(entityName)}Repository ${Utils.toCamelCase(entityName)}Repository;`).join('\n')
            const dependsServiceList = methodData.serviceList.map(serviceName => `\t@Autowired\n\tprivate ${Utils.toPascalCase(serviceName)} ${Utils.toCamelCase(serviceName)};`).join('\n')
            serviceImports.add('Service');
            serviceImports.add('Slf4j');
            serviceImports.add('Autowired');
            serviceImports.add('HttpStatus');

            const serviceImportString = Array.from(serviceImports).map(imp => JAVA_FQCN_MAP[imp]).filter(imp => imp).map(imp => `import ${imp};\n`).join('');
            const serviceClassTemplate = Utils.trimLines(`
                package ${PACKAGE_NAME}.domain.service;
                
                import ${PACKAGE_NAME}.exception.CustomException;
                import ${PACKAGE_NAME}.exception.ResourceNotFoundException;
                import org.springframework.http.HttpStatus;
                ${dependsEntityImportList}
                ${dependsRepositoryImportList}
                ${dependsServiceImportList}
                ${serviceImportString}

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

            // methodObject.push({
            //     methodSignature: Utils.trimLines(`
            //         ${interfaceTypeList}
            //         \t/**
            //         \t * ${methodData.name}
            //         \t */
            //         \tpublic ${pascalServiceName}${pascalMethodName}ResponseDto ${Utils.toCamelCase(methodName)}(${pascalServiceName}${pascalMethodName}RequestDto request);
            //     `),
            // });
        });

        // // serviceのインターフェースを組み立てる。これは参照用に使われるので、全メソッドをひとまとめにしておく。
        // javaServiceTemplateMap[serviceName] = Utils.trimLines(`
        //     package ${PACKAGE_NAME}.domain.service;
        //     import lombok.Data;
        //     import java.util.List;
        //     import java.util.Map;
        //     import java.time.LocalDate;
        //     import java.time.LocalDateTime;
        //     import java.time.LocalTime;
        //     import ${PACKAGE_NAME}.domain.entity.*;
        //     import ${PACKAGE_NAME}.domain.enums.*;
        //     /**
        //      * ${serviceName}
        //      */
        //     public interface ${Utils.toPascalCase(serviceName)} {
        //     ${methodObject.map(method => method.methodSignature).join('\n')}
        //     }
        // `).replace(/\t/g, '    '); // タブをスペース4つに変換
    });
    return javaServiceTemplateMap;
}

/**
 * サービスの型（メソッド名と入出力の型）が決まったら
 * Angularのserviceを生成する。
 * @param serviceList 
 * @param serviceModel 
 * @param serviceDocs 
 * @param entityData 
 * @returns 
 */
export function angularServiceMap(
    serviceList: { [key: string]: { [key: string]: ServiceMethod } },
    serviceModel: Record<string, DtoClass>,
    serviceDocs: Record<string, string>,
    entityData: EntityDetailFilledType,
): Record<string, string> {

    // 独自定義の型
    const models = [...Object.keys(entityData.classes), ...Object.keys(entityData.enums)];

    const angularServiceSourceMap: Record<string, string> = {};
    Object.keys(serviceList).forEach(serviceName => {
        const pascalServiceName = Utils.toPascalCase(serviceName);

        const methodObject: { methodName: string, angularServiceInterface: string, angularService: string }[] = [];

        const angularUnmatchedTypeSet = new Set<string>();
        const angularDefineTypeSet = new Set<string>();
        Object.keys(serviceList[serviceName]).forEach(methodName => {
            const joinKey = Utils.safeFileName(`${serviceName}.${methodName}`);

            // serviceDataから必要な情報を抽出
            const methodData = serviceList[serviceName][methodName];
            const pascalMethodName = Utils.toPascalCase(methodName);

            // serviceDocsDataから処理概要を抽出（インターフェースのコメントに使用）
            const match0 = serviceDocs[joinKey].match(/## 機能概要([\s\S]*?)## API仕様/);
            const description = (match0 ? match0[1].trim() : '').split('\n').map(line => `\t * ${line}`).join('\n');

            // requestDtoのモデルからリクエストとレスポンスの構造体を生成
            function modelToTypescript(dtoClass: DtoClass): string {
                // 未対応の型を抽出
                dtoClass.fields.forEach(field => unmatchedType(field.type).forEach(type => { angularUnmatchedTypeSet.add(type); }));
                // ここで定義する型を抽出
                angularDefineTypeSet.add(dtoClass.name);
                return Utils.trimLines(`
                    export interface ${dtoClass.name} {
                    ${dtoClass.fields.map(field => `\n\t${field.name}: ${javaTypeToTypescript(field.type)};`).join('') || '\n\t// no fields'}
                    }
                    ${dtoClass.innerClasses.map(innerClass => `\n${modelToTypescript(innerClass)}`).join('\n') || Utils.TRIM_LINES_DELETE_LINE}
                `);
            }
            // Angularの型定義を組み立てる
            const angularServiceInterface = serviceModel[serviceName].innerClasses
                .filter(innerClass => innerClass.name.startsWith(`${pascalServiceName}${pascalMethodName}`))
                // .filter(key => Object.keys(entityData.classes).indexOf(key) === -1)
                .map(innerClass => modelToTypescript(innerClass)).join('\n\n');

            // メソッドシグネチャを組み立てる
            let angularServiceMethodSignature;
            // console.log(methodData.method + ' '.repeat(4 - methodData.method.length), methodData.endpoint, methodData.pathVariableList, methodData.request);
            if (['POST', 'PUT', 'PATCH'].includes(methodData.method)) {
                // POST, PUT, PATCHの場合はpathVariableが無いように調整済みなのでリクエストボディのみを受け取る
                angularServiceMethodSignature = Utils.trimLines(`
                    \t${Utils.toCamelCase(methodName)}(requestDto: ${pascalServiceName}${pascalMethodName}RequestDto): Observable<${pascalServiceName}${pascalMethodName}ResponseDto> {
                    \t\treturn this.http.${methodData.method.toLowerCase()}<${pascalServiceName}${pascalMethodName}ResponseDto>(\`\${this.apiUrl}${methodData.endpoint}\`, requestDto, { headers: this.getHeaders() });
                    \t}
                `);
            } else {
                // GET, DELETEの場合はpathVariableを受け取る
                const endpoint = methodData.endpoint.replace(/\{(\w+)\}/g, '\${requestDto.$1}');
                angularServiceMethodSignature = Utils.trimLines(`
                    \t${Utils.toCamelCase(methodName)}(requestDto: ${pascalServiceName}${pascalMethodName}RequestDto): Observable<${pascalServiceName}${pascalMethodName}ResponseDto> {
                    \t\treturn this.http.${methodData.method.toLowerCase()}<${pascalServiceName}${pascalMethodName}ResponseDto>(\`\${this.apiUrl}${endpoint}\`, { headers: this.getHeaders() });
                    \t}
                `);
            }

            // メソッドのソースを組み立てる
            const angularService = Utils.trimLines(`
                \t/**
                \t * ${methodData.name}
                \t *
                \t * # 処理詳細
                ${description}
                \t *
                \t * @param request
                \t * @return
                \t */
                ${angularServiceMethodSignature}
                \t
            `);
            // console.log(angularService);

            methodObject.push({ methodName, angularServiceInterface, angularService, });
        });

        // 独自定義のうち、サービス内で定義する型を除外する。
        Array.from(angularDefineTypeSet).forEach(type => angularUnmatchedTypeSet.delete(type));
        // サービスのソースを組み立てる
        const angularService = Utils.trimLines(`
            import { Injectable } from '@angular/core';
            import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
            import { Observable } from 'rxjs';
            import { environment } from 'src/environments/environment';
            import { ${Array.from(angularUnmatchedTypeSet).filter(type => models.includes(type)).join(', ')} } from '../models/models';

            @Injectable({ providedIn: 'root' })
            export class ${pascalServiceName} {
            
            \tprivate apiUrl = environment.apiUrl + '/api/v1';
            \tconstructor(private http: HttpClient) { }
            
            \tprivate getHeaders(): HttpHeaders {
            \t\treturn new HttpHeaders({
            \t\t\t'Content-Type': 'application/json',
            \t\t\t'Authorization': 'Bearer ' + localStorage.getItem('token'),
            \t\t});
            \t}
            
            ${methodObject.map(method => method.angularService).join('\n')}
            }

            ${methodObject.map(method => method.angularServiceInterface).join('\n')}
        `);
        // console.log(angularService);

        // 生成したテンプレートをキャッシュ
        angularServiceSourceMap[serviceName] = angularService.replace(/\t/g, '    ');      // タブをスペース4つに変換;
    });
    return angularServiceSourceMap;
}

/**
 * 実装が決まったらテンプレートにはめ込む
 * @param serviceList 
 * @param serviceModel 
 * @param serviceDocs 
 * @param serviceImplData 
 * @param entityData 
 * @param PACKAGE_NAME 
 * @returns 
 */
export function javaServiceImplementsMap(
    serviceList: { [key: string]: { [key: string]: ServiceMethod } },
    serviceModel: Record<string, DtoClass>,
    serviceDocs: Record<string, string>,
    serviceImplData: Record<string, {
        additionalImports: string[],
        additionalInjections: string[],
        methodAnnotations: string[],
        methodBodyInnerCodes: string[],
    }>,
    entityData: EntityDetailFilledType,
    PACKAGE_NAME: string,
): Record<string, { implement: string }> {
    const javaServiceSourceMap: Record<string, { implement: string }> = {};
    Object.keys(serviceList).forEach(serviceName => {
        const pascalServiceName = Utils.toPascalCase(serviceName);

        const methodObject: { methodName: string, methodBody: string, }[] = [];
        const imports = new Set<string>();
        const injections = new Set<string>();

        Object.keys(serviceList[serviceName]).forEach(methodName => {
            const joinKey = Utils.safeFileName(`${serviceName}.${methodName}`);

            // serviceDataから必要な情報を抽出
            const methodData = serviceList[serviceName][methodName];
            const pascalMethodName = Utils.toPascalCase(methodName);

            // serviceDocsDataから処理概要を抽出（インターフェースのコメントに使用）
            const match0 = serviceDocs[joinKey].match(/## 機能概要([\s\S]*?)## API仕様/);
            const description = (match0 ? match0[1].trim() : '').split('\n').map(line => `\t * ${line}`).join('\n');

            // serviceDocsDataからバックエンド処理詳細とビジネスロジックを抽出（実装のコメントに使用）
            const match = serviceDocs[joinKey].match(/## バックエンド処理詳細([\s\S]*?)## ビジネスロジック([\s\S]*?)$/);
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

            // TODO
            // @Autowiredと変数宣言の行が分離してしまうケースがある。対症療法的に対応するが、本来はやっぱりjavaコードで作らせてパースするべき
            if (serviceImplData[joinKey].additionalInjections.length > 0 && '@Autowired' === serviceImplData[joinKey].additionalInjections[0]) {
                const newAdditionalInjections = [];
                for (let i = 0; i < serviceImplData[joinKey].additionalInjections.length; i += 2) {
                    newAdditionalInjections.push(serviceImplData[joinKey].additionalInjections[i] + ' ' + serviceImplData[joinKey].additionalInjections[i + 1]);
                }
                serviceImplData[joinKey].additionalInjections = newAdditionalInjections;
            }

            serviceImplData[joinKey].additionalImports.forEach(imp => imports.add(imp.trim().replace(/^import /g, '').replace(/;$/g, '')));
            serviceImplData[joinKey].additionalInjections.forEach(inj => injections.add(inj.trim().replace(/\s+/g, ' ').replace(/^@Autowired\s/g, '\t@Autowired\n\t').replace(/;$/g, '') + ';'));

            function formatCodeBody(code: string): string {
                const codeList = code.split('\n');
                let indentSpaceSize = 0;
                let indentLineNumber = 0;
                // インデントを探す
                for (let i = 0; i < codeList.length; i++) {
                    const match = codeList[i].match(/^\s*/);
                    // ドット開始の行はインデント検知から除外
                    if (match && !codeList[i].match(/^\s*\./)) {
                        // インデントがある場合
                        indentSpaceSize = match[0].length;
                        indentLineNumber = i;
                        break;
                    }
                }

                if (indentLineNumber === 0) {
                    // 最初の行がインデントされている場合は一旦全部のインデントを削除する
                    for (let i = 0; i < codeList.length; i++) {
                        // 正規表現を使って指定された数の空白文字を削除
                        const regex = new RegExp(`^\\s{0,${indentSpaceSize}}`);
                        // codeList[i] = codeList[i].substring(indentSpaceSize);
                        codeList[i] = codeList[i].replace(regex, '');
                    }
                } else { }

                // 強制的に4スペースインデントにする
                for (let i = 0; i < codeList.length; i++) {
                    codeList[i] = '\t'.repeat(2) + codeList[i];
                }

                return codeList.join('\n');
            }
            const methodBody = Utils.trimLines(`
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
                ${serviceImplData[joinKey].methodAnnotations.filter(anno => !['@Override'].includes(anno)).map(anno => `\t${anno}`).join('\n') || Utils.TRIM_LINES_DELETE_LINE}
                \t@Override
                \tpublic ${pascalServiceName}${pascalMethodName}ResponseDto ${Utils.toCamelCase(methodName)}(${pascalServiceName}${pascalMethodName}RequestDto request) {
                ${formatCodeBody(serviceImplData[joinKey].methodBodyInnerCodes.join('\n'))}
                \t}
                \t
            `);
            methodObject.push({
                methodName,
                methodBody,
            });
        });

        imports.add(`org.springframework.stereotype.Service`);
        imports.add(`org.springframework.beans.factory.annotation.Autowired`);
        imports.add(`org.springframework.http.MediaType`);
        imports.add(`org.springframework.http.HttpStatus`);
        imports.add(`org.springframework.transaction.annotation.Transactional`);
        imports.add(`org.springframework.web.multipart.MultipartFile`);
        imports.add(`lombok.Data`);
        imports.add(`lombok.EqualsAndHashCode`);
        imports.add(`lombok.RequiredArgsConstructor`);
        imports.add(`lombok.extern.slf4j.Slf4j`);
        imports.add(`${PACKAGE_NAME}.domain.entity.*`);
        imports.add(`${PACKAGE_NAME}.domain.enums.*`);
        imports.add(`${PACKAGE_NAME}.domain.repository.*`);
        imports.add(`${PACKAGE_NAME}.exception.CustomException`);
        imports.add(`${PACKAGE_NAME}.exception.ResourceNotFoundException`);
        imports.add(`java.io.*`);
        imports.add(`java.util.List`);
        imports.add(`java.util.Map`);
        imports.add(`java.time.LocalDate`);
        imports.add(`java.time.LocalDateTime`);
        imports.add(`java.time.LocalTime`);

        // javaxはjakartaに置換
        const importList = Array.from(imports)
            .filter(imp => !imp.startsWith('java.lang.'))
            .filter(imp => !imp.startsWith('javax.transaction.Transactional'))
            .map(imp => 'import ' + imp.replace('javax.persistence.', 'jakarta.persistence.').replace('javax.validation.', 'jakarta.validation.') + ';').join('\n');

        // TODO injections の名前の重複が無いか再点検した方がいい
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
            
            ${importList}

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

        // 生成したテンプレートをキャッシュ
        javaServiceSourceMap[serviceName] = {
            implement: serviceClassImplement.replace(/\t/g, '    '),    // タブをスペース4つに変換
        };
    });
    // return serviceTemplate.replace('${serviceName}', serviceName).replace('${methods}', methods.join('\n'));
    return javaServiceSourceMap;
}

