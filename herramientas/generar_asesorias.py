"""Une las franjas de asesoría seguidas de cada docente y genera apps-script/asesorias_datos.gs.
Uso: python3 herramientas/generar_asesorias.py"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from datos_asesorias import franjas, NOMBRES, NUEVOS
import datos_horario as dh

nombres = {c: n for c, n, _, _ in dh.docentes}
nombres.update(NUEVOS)
orden = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes"]

def bloques():
    por = {}
    for prog, dia, ini, fin, docs in franjas:
        for d in docs:
            cod = NOMBRES[d]
            s = por.setdefault((cod, dia), {})
            s[(ini, fin)] = s.get((ini, fin), set()) | {prog}
    out = []
    for (cod, dia), s in por.items():
        tramos = sorted(s.items())
        cur = None
        for (ini, fin), progs in tramos:
            if cur and cur["fin"] >= ini:
                cur["fin"] = max(cur["fin"], fin); cur["progs"] |= progs
            else:
                cur = {"cod": cod, "dia": dia, "ini": ini, "fin": fin, "progs": set(progs)}; out.append(cur)
    out.sort(key=lambda b: (orden.index(b["dia"]), b["ini"], nombres[b["cod"]]))
    filas = []
    for b in out:
        prog = " / ".join(sorted(b["progs"], key=["Electrónica", "Electromecánica"].index))
        filas.append(["ASE-%s-%s-%s" % (b["cod"], b["dia"][:2].upper(), b["ini"].replace(":", "")), b["dia"], b["ini"], b["fin"],
                      "ASESORIA", "ASESORÍA · Ing. " + prog, b["cod"], nombres[b["cod"]], "", prog])
    return filas

def choques(filas):
    clases = [(c, d, i, f, s, m) for c, n, _, mats in dh.docentes for (_, _, _, m, hs) in mats for (d, i, f, s) in hs]
    r = []
    for a in filas:
        for c, d, i, f, s, m in clases:
            if c == a[6] and d == a[1] and i < a[3] and a[2] < f:
                r.append("%s %s %s–%s asesoría choca con %s %s–%s (%s)" % (a[7], d, a[2], a[3], m, i, f, s))
    return r

if __name__ == "__main__":
    filas = bloques()
    raiz = os.path.join(os.path.dirname(__file__), "..")
    with open(os.path.join(raiz, "apps-script", "asesorias_datos.gs"), "w", encoding="utf8") as fh:
        fh.write("// Generado por herramientas/generar_asesorias.py a partir de los horarios de asesorías 2026-2. No editar a mano:\n"
                 "// para cambiar asesorías edita la hoja \"Asesorías\" directamente.\n"
                 "// Columnas: ID, Día, Hora inicio, Hora fin, Código materia, Materia, Código docente, Docente, Salón, Programa\n")
        fh.write("var ASESORIAS_2026_2 = " + json.dumps(filas, ensure_ascii=False, indent=0).replace("\n", "") .replace("],[", "],\n [") + ";\n")
        fh.write("var DOCENTES_NUEVOS_ASESORIAS = " + json.dumps([[c, n] for c, n in NUEVOS.items()], ensure_ascii=False) + ";\n")
    print(len(filas), "bloques de asesoría,", len({f[6] for f in filas}), "docentes")
    for c in choques(filas): print("CHOQUE:", c)
