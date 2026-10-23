'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { springFindings, indexSpring } = require('../src/core/spring');
const { F } = require('../src/core/detectors');

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-spring-'));
  fs.writeFileSync(path.join(root, 'pom.xml'), '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>');
  for (const [rel, src] of Object.entries(files)) {
    const abs = path.join(root, 'src/main/java/demo', rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, src);
  }
  return root;
}

test('Spring: reglas que compilan pero fallan al ejecutar', () => {
  const root = project({
    'Cat.java': '@Entity\npublic class Cat {\n  @Id private Long id;\n  private String codice;\n}\n',
    'Ev.java': '@Entity\npublic class Ev {\n  @Id private Long id;\n  @ManyToOne\n  private Cat categoria;\n}\n',
    'Repo.java': 'public interface Repo extends JpaRepository<Ev, Long> {\n  @Query("SELECT e FROM Ev e WHERE e.categoria.codiceCat = :c")\n  List<Ev> filtra(String c);\n}\n',
    'Dto.java': 'public record Dto(@NotBlank String nome) {}\n',
    'Svc.java': '@Service\npublic class Svc {\n  @Autowired\n  private Repo repo;\n  public Ev uno(Long id) {\n    return repo.findById(id).get();\n  }\n}\n',
    'Ctl.java': '@RestController\n@RequestMapping("/api/ev")\npublic class Ctl {\n  private final Svc svc;\n  public Ctl(Svc svc) { this.svc = svc; }\n  @GetMapping("/{id}")\n  public ResponseEntity<Ev> uno(@PathVariable Long id) { return ResponseEntity.ok(svc.uno(id)); }\n  @PostMapping\n  public Dto crea(@RequestBody Dto dto) { return dto; }\n}\n',
  });
  const idx = indexSpring(root);
  assert.deepStrictEqual(idx.endpoints.map((e) => e.method + ' ' + e.path), ['GET /api/ev/{id}', 'POST /api/ev']);
  const by = Object.fromEntries(springFindings(root, F, idx).map((f) => [f.rule, f]));
  assert.strictEqual(by['spring-jpql-attribute'].line, 2);
  assert.match(by['spring-jpql-attribute'].title, /codiceCat/);
  assert.strictEqual(by['spring-field-injection'].line, 3);
  assert.strictEqual(by['spring-eager-to-one'].line, 4);
  assert.strictEqual(by['spring-optional-get'].line, 6);
  assert.strictEqual(by['spring-entity-response'].file, 'src/main/java/demo/Ctl.java');
  assert.ok(by['spring-missing-valid']);
});

test('Spring: avisa de la configuración que falta y dice dónde escribirla', async () => {
  const { readConfig, configNeeds, failureNeeds } = require('../src/core/springrun');
  const root = project({ 'App.java': '@Service\npublic class App {\n  @Value("${clave.externa}")\n  private String k;\n}\n' });
  const res = path.join(root, 'src/main/resources');
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(res, 'application.properties'), 'server.port=8080\nspring.datasource.url=jdbc:postgresql://127.0.0.1:1/db\nstripe.api-key=\npagos.url=${PAGOS_SPECTATOR_TEST}\n');
  const cfg = readConfig(root);
  const idx = indexSpring(root);
  const needs = await configNeeds(root, cfg, idx);
  const at = (kind, key) => needs.find((n) => n.kind === kind && n.key === key);
  assert.strictEqual(at('db', 'spring.datasource.url').line, 2);
  assert.strictEqual(at('secret', 'stripe.api-key').line, 3);
  assert.strictEqual(at('env', 'pagos.url').env, 'PAGOS_SPECTATOR_TEST');
  assert.strictEqual(at('env', 'clave.externa').file, 'src/main/java/demo/App.java');
  assert.ok(at('secret', 'spring.datasource.password').add, 'la contraseña que falta se añade al final del archivo');
  const fromLog = failureNeeds("Caused by: java.lang.RuntimeException: Failed to load driver class org.postgresql.Driver\nCould not resolve placeholder 'otra.cosa'", cfg, idx);
  assert.ok(fromLog.some((n) => n.kind === 'driver' && n.file === 'pom.xml'));
  assert.ok(fromLog.some((n) => n.kind === 'env' && n.env === 'OTRA_COSA'));
});
