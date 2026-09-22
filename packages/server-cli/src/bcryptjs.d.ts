declare module "bcryptjs" {
  interface Bcrypt {
    hashSync(value: string, rounds: number): string;
    compareSync(value: string, hash: string): boolean;
  }

  const bcrypt: Bcrypt;
  export default bcrypt;
}
