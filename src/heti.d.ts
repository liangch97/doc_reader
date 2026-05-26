declare module 'heti/js/heti-addon.js' {
  export default class Heti {
    constructor(root: HTMLElement | string)
    autoSpacing(): void
    spacingElement(el: HTMLElement): void
    spacingElements(list: HTMLElement[] | NodeList): void
  }
}

declare module 'heti/umd/heti.min.css'
