import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmRawTransaction,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RECENT_BLOCKHASHES_PUBKEY,
  ComputeBudgetProgram,
  Transaction,
} from "@solana/web3.js";
import {
  CandyMachine,
  createMintNftInstruction,
  createSetCollectionDuringMintInstruction,
  PROGRAM_ID,
} from "@cardinal/mpl-candy-machine-utils";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  Token,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Edition,
  MasterEdition,
  Metadata,
  MetadataProgram,
} from "@metaplex-foundation/mpl-token-metadata";
import { remainingAccountsForLockup } from "@cardinal/mpl-candy-machine-utils";
import { utils } from "@project-serum/anchor";

const walletKeypair = Keypair.fromSecretKey(
  new Uint8Array([1, 2, 3, 4, 5]) // 自分のシークレットキーを入力
);
const candyMachineId = new PublicKey("EWgWphM4MVNewYHqvYE5pKFD6KqgXDoMbnbmbvWqQwjU");
const collectionMintKeypair = Keypair.generate();
const whitelistMint = new PublicKey("7jEt7ph4Zu4mGMZKJTsKv39NbhfBp6SP3cZYRFRWJ7vX"); // CMに設定しているwhitelist tokenに置き換え

const receiver = new PublicKey("3HgNNY6aaFLTgviU6ZpRKoHF37Hj4r11sJeaExDVuQbA"); // NFTを受け取る人

const connection = new Connection("https://devnet.genesysgo.net/", "confirmed");

const mintNft = async () => {
  const nftToMintKeypair = Keypair.generate();
  const tokenAccountToReceive = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    nftToMintKeypair.publicKey,
    receiver, // 受け取るのはreceiver
    false
  );

  const metadataId = await Metadata.getPDA(nftToMintKeypair.publicKey);
  const masterEditionId = await Edition.getPDA(nftToMintKeypair.publicKey);
  const whitelistMintTokenAccount = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    whitelistMint,
    walletKeypair.publicKey,
    false
  );
  const [candyMachineCreatorId, candyMachineCreatorIdBump] =
    await PublicKey.findProgramAddress(
      [Buffer.from("candy_machine"), candyMachineId.toBuffer()],
      PROGRAM_ID
    );
  const candyMachine = await CandyMachine.fromAccountAddress(connection, candyMachineId);
  const mintIx = createMintNftInstruction(
    {
      candyMachine: candyMachineId,
      candyMachineCreator: candyMachineCreatorId,
      payer: walletKeypair.publicKey,
      wallet: candyMachine.wallet,
      metadata: metadataId,
      mint: nftToMintKeypair.publicKey,
      mintAuthority: walletKeypair.publicKey,
      updateAuthority: walletKeypair.publicKey,
      masterEdition: masterEditionId,
      tokenMetadataProgram: MetadataProgram.PUBKEY,
      clock: SYSVAR_CLOCK_PUBKEY,
      recentBlockhashes: SYSVAR_RECENT_BLOCKHASHES_PUBKEY,
      instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
    },
    {
      creatorBump: candyMachineCreatorIdBump,
    }
  );
  const [collectionPdaId, _collectionPdaBump] =
    await PublicKey.findProgramAddress(
      [Buffer.from("collection"), candyMachineId.toBuffer()],
      PROGRAM_ID
    );
  const collectionMintMetadataId = await Metadata.getPDA(
    collectionMintKeypair.publicKey
  );
  const collectionMasterEditionId = await MasterEdition.getPDA(
    collectionMintKeypair.publicKey
  );

  const [collectionAuthorityRecordId] = await PublicKey.findProgramAddress(
    [
      Buffer.from("metadata"),
      MetadataProgram.PUBKEY.toBuffer(),
      collectionMintKeypair.publicKey.toBuffer(),
      Buffer.from("collection_authority"),
      collectionPdaId.toBuffer(),
    ],
    MetadataProgram.PUBKEY
  );

  const setCollectionDuringMintIx = createSetCollectionDuringMintInstruction({
    candyMachine: candyMachineId,
    metadata: metadataId,
    payer: walletKeypair.publicKey,
    collectionPda: collectionPdaId,
    tokenMetadataProgram: MetadataProgram.PUBKEY,
    instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    collectionMint: collectionMintKeypair.publicKey,
    collectionMasterEdition: collectionMasterEditionId,
    collectionMetadata: collectionMintMetadataId,
    authority: walletKeypair.publicKey,
    collectionAuthorityRecord: collectionAuthorityRecordId,
  });

  const instructions = [
    ComputeBudgetProgram.requestUnits({ units: 400_000, additionalFee: 0 }), // Program returned error: Computational budget exceededを防ぐためにcompute budgetを確保
    {
      ...mintIx,
      keys: [
        ...mintIx.keys,
        // remaining accounts for whitelist
        {
          pubkey: whitelistMintTokenAccount,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: whitelistMint,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: walletKeypair.publicKey,
          isSigner: false,
          isWritable: false,
        },
        // remaining accounts for minting the token during execution
        {
          pubkey: tokenAccountToReceive,
          isSigner: false,
          isWritable: true,
        },
        // remaining accounts for locking
        ...(await remainingAccountsForLockup(candyMachineId, nftToMintKeypair.publicKey, tokenAccountToReceive)),
      ],
    },
    // setCollectionDuringMintIx, // コレクションはセットしていない。
  ];
  const tx = new Transaction();
  tx.instructions = instructions;
  tx.feePayer = walletKeypair.publicKey;
  tx.recentBlockhash = (await connection.getRecentBlockhash()).blockhash;
  tx.sign(walletKeypair, nftToMintKeypair);
  const txid = await sendAndConfirmRawTransaction(connection, tx.serialize());
  console.log(
    `Succesfully minted token ${nftToMintKeypair.publicKey.toString()} from candy machine with address ${candyMachineId.toString()} https://explorer.solana.com/tx/${txid}`
  );
};

mintNft();
