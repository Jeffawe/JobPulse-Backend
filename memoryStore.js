export const emailUpdates = []; // Acts like a shared queue for frontend

export const addToEmailUpdates = (email) => {
  emailUpdates.push(email);
};

export const getAndClearEmailUpdates = () => {
  const temp = [...emailUpdates];
  emailUpdates.length = 0;
  return temp;
};