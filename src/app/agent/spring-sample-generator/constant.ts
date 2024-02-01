export function javaTypeToTypescript(type: string): string {
    // generics内のアノテーションがある場合は除外する
    return type.split(/([<>,\s])/).filter(t => !t.startsWith('@')).map((t) =>
        javaTypeToTypescriptMap[t.trim()] || t
    ).join('').trim().replace(/<\s+/g, '<');
}

/**
 * Javaの型名をTypeScriptの型名に変換する置換表に載っていない型名は独自クラスとみなす。
 * @param type 
 * @returns 
 */
export function unmatchedType(type: string): string[] {
    const unmatched: string[] = [];
    // generics内のアノテーションがある場合は除外する
    type.split(/([<>,\s])/).filter(t => !t.startsWith('@')).forEach((t) => {
        if (!javaTypeToTypescriptMap[t.trim()] && !t.match(/[<>,\s]+/) && t.trim()) {
            unmatched.push(t);
        } else { }
    });
    return unmatched;
}

const javaTypeToTypescriptMap: Record<string, string> = {
    void: 'void',
    Object: 'object',
    String: 'string',
    Character: 'string',
    char: 'string',
    Boolean: 'boolean',
    boolean: 'boolean',
    // 数値系 ////////////////////////////
    int: 'number',
    float: 'number',
    double: 'number',
    long: 'number',
    short: 'number',
    byte: 'number',
    Integer: 'number',
    Float: 'number',
    Double: 'number',
    Long: 'number',
    Short: 'number',
    Byte: 'number',
    Number: 'number',
    'byte[]': 'number[]',
    BigInteger: 'string',
    BigDecimal: 'string',
    // Date系 ////////////////////////////
    Date: 'string',
    Time: 'string',
    Timestamp: 'string',
    LocalDate: 'string',
    LocalTime: 'string',
    LocalDateTime: 'string',
    Period: 'string',
    'java.util.Date': 'Date',
    'java.time.Period': 'string',
    // util系 ////////////////////////////
    List: 'Array',
    Map: 'Record',
    Set: 'Set',
    'java.util.List': 'Array',
    'java.util.Map': 'Record',
    'java.util.Set': 'Set',
    'java.io.File': 'File',
    // ZonedDateTime: 'ZonedDateTime',
    // OffsetDateTime: 'OffsetDateTime',
    // OffsetTime: 'OffsetTime',
    // Blob: 'Blob',
    // Clob: 'Clob',
    // Array: 'Array',
    // Ref: 'Ref',
    // URL: 'URL',
    // URI: 'URI',
    // UUID: 'UUID',
    // TimeUUID: 'TimeUUID',
    // InetAddress: 'InetAddress',
    // File: 'File',
    // Path: 'Path',
    // Class: 'Class',
    // Locale: 'Locale',
    // Currency: 'Currency',
    // TimeZone: 'TimeZone',
    // SimpleDateFormat: 'SimpleDateFormat',
    // DateTimeFormatter: 'DateTimeFormatter',
    // DateTimeFormat: 'DateTimeFormat',
    // DateTimeFormatterBuilder: 'DateTimeFormatterBuilder',
    // PeriodFormatter: 'PeriodFormatter',
    // PeriodFormatterBuilder: 'PeriodFormatterBuilder',
    // PeriodFormat: 'PeriodFormat',
};

export const JAVA_FQCN_MAP: Record<string, string> = {
    File: 'java.io.File',
    BigDecimal: 'java.math.BigDecimal',
    BigInteger: 'java.math.BigInteger',

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
    CascadeType: 'jakarta.persistence.CascadeType',
    Embeddable: 'jakarta.persistence.Embeddable',
    Embedded: 'jakarta.persistence.Embedded',
    EmbeddedId: 'jakarta.persistence.EmbeddedId',

    // jakarta.validation.constraints: 'jakarta.validation.constraints.*',
    NotBlank: 'jakarta.validation.constraints.NotBlank',
    NotNull: 'jakarta.validation.constraints.NotNull',
    Size: 'jakarta.validation.constraints.Size',
    Min: 'jakarta.validation.constraints.Min',
    Max: 'jakarta.validation.constraints.Max',
    DecimalMin: 'jakarta.validation.constraints.DecimalMin',
    DecimalMax: 'jakarta.validation.constraints.DecimalMax',

    PastOrPresent: 'jakarta.validation.constraints.PastOrPresent',
    FutureOrPresent: 'jakarta.validation.constraints.FutureOrPresent',
    Past: 'jakarta.validation.constraints.Past',

    Email: 'jakarta.validation.constraints.Email',
    Positive: 'jakarta.validation.constraints.Positive',
    PositiveOrZero: 'jakarta.validation.constraints.PositiveOrZero',
    Negative: 'jakarta.validation.constraints.Negative',
    NegativeOrZero: 'jakarta.validation.constraints.NegativeOrZero',
    NotEmpty: 'jakarta.validation.constraints.NotEmpty',
    NotNegative: 'jakarta.validation.constraints.NotNegative',
    NotPositive: 'jakarta.validation.constraints.NotPositive',
    Pattern: 'jakarta.validation.constraints.Pattern',

    Valid: 'jakarta.validation.Valid',
    // org.hibernate.validator.constraints: 'org.hibernate.validator.constraints.*',
    Range: 'org.hibernate.validator.constraints.Range',
    Length: 'org.hibernate.validator.constraints.Length',


    // org.springframework.data.jpa.repository: 'org.springframework.data.jpa.repository.*',
    JpaRepository: 'org.springframework.data.jpa.repository.JpaRepository',
    Repository: 'org.springframework.stereotype.Repository',
    Service: 'org.springframework.stereotype.Service',
    Autowired: 'org.springframework.beans.factory.annotation.Autowired',
    HttpStatus: 'org.springframework.http.HttpStatus',
    Transactional: 'org.springframework.transaction.annotation.Transactional',

    RestController: 'org.springframework.web.bind.annotation.RestController',
    RequestMapping: 'org.springframework.web.bind.annotation.RequestMapping',
    GetMapping: 'org.springframework.web.bind.annotation.GetMapping',
    PostMapping: 'org.springframework.web.bind.annotation.PostMapping',
    PutMapping: 'org.springframework.web.bind.annotation.PutMapping',
    DeleteMapping: 'org.springframework.web.bind.annotation.DeleteMapping',
    PathVariable: 'org.springframework.web.bind.annotation.PathVariable',
    RequestBody: 'org.springframework.web.bind.annotation.RequestBody',
    ResponseBody: 'org.springframework.web.bind.annotation.ResponseBody',
    Validated: 'org.springframework.validation.annotation.Validated',
    // Valid: 'org.springframework.validation.annotation.Valid',
    

    // lombok: 'lombok.*',
    RequiredArgsConstructor: 'lombok.RequiredArgsConstructor',
    AllArgsConstructor: 'lombok.AllArgsConstructor',
    NoArgsConstructor: 'lombok.NoArgsConstructor',
    EqualsAndHashCode: 'lombok.EqualsAndHashCode',
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


// import jakarta.persistence.Column;
// import jakarta.persistence.Entity;
// import jakarta.persistence.EnumType;
// import jakarta.persistence.Enumerated;
// import jakarta.persistence.GeneratedValue;
// import jakarta.persistence.GenerationType;
// import jakarta.persistence.Id;
