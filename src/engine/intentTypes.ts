/** Forma mínima de una especialidad para la detección por palabras clave. */
export interface Especialidad {
  nombre: string;
  palabrasClave: readonly string[];
}
