const SECRET_LINK = /^\s*(otpauth(?:-migration)?):/i;

export const hoverStatus = (text: string) => {
  const secret = SECRET_LINK.exec(text);
  return secret ? `${secret[1]!.toLowerCase()}:` : text;
};
